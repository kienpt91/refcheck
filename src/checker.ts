import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Config } from "./config.js";
import { globToRegExp, matchesAny } from "./glob.js";
import { closest } from "./fuzzy.js";
import { resolveExports, type ImportKind } from "./exports-map.js";
import {
  findInstalled,
  isBuiltin,
  packageNameFromPath,
  ProjectDeps,
  readPackageJson,
  splitSpecifier,
  subpathExistsOnDisk,
} from "./packages.js";
import { DEFAULT_SEVERITY, isRuleId } from "./rules.js";
import { isSuppressed, parseSuppressions, type Suppressions } from "./suppress.js";
import { UsageError, type Finding, type Report } from "./types.js";

export interface CheckOptions {
  /** Real, absolute project root. */
  root: string;
  /** Absolute source files to check. */
  files: string[];
  config: Config;
}

const JS_FILE = /\.[cm]?jsx?$/;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function inNodeModules(file: string): boolean {
  return file.replaceAll("\\", "/").includes("/node_modules/");
}

/** A declaration from a typed (non-JS) file inside node_modules. */
function isExternalDecl(decl: ts.Node | undefined): boolean {
  if (!decl) return false;
  const name = decl.getSourceFile().fileName;
  return inNodeModules(name) && !JS_FILE.test(name);
}

function isFunctionLike(decl: ts.Declaration): boolean {
  return ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) || ts.isConstructorDeclaration(decl);
}

interface ArgRange {
  min: number;
  max: number;
}

interface KeySet {
  keys: Set<string>;
  open: boolean;
  sawObject: boolean;
}

function propertyName(prop: ts.ObjectLiteralElementLike): string | undefined {
  if (ts.isSpreadAssignment(prop)) return undefined;
  const name = prop.name;
  if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) return name.text;
  return undefined;
}

function describeRanges(ranges: ArgRange[]): string {
  const parts = [...new Set(ranges.map((r) => (r.max === Infinity ? `${r.min}+` : r.min === r.max ? `${r.min}` : `${r.min}-${r.max}`)))];
  return parts.join(" or ");
}

function compilerOptions(root: string): ts.CompilerOptions {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    types: [],
  };
  const tsconfig = path.join(root, "tsconfig.json");
  if (fs.existsSync(tsconfig)) {
    const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
    if (!read.error) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, tsconfig);
      const o = parsed.options;
      if (o.paths) options.paths = o.paths;
      if (o.baseUrl) options.baseUrl = o.baseUrl;
      if (o.pathsBasePath) options["pathsBasePath"] = o.pathsBasePath;
      if (o.jsx !== undefined) options.jsx = o.jsx;
      if (o.jsxImportSource) options.jsxImportSource = o.jsxImportSource;
      if (o.lib) options.lib = o.lib;
    }
  }
  return options;
}

export function checkFiles(opts: CheckOptions): Report {
  const { root, config } = opts;
  if (!fs.existsSync(path.join(root, "package.json"))) {
    throw new UsageError(`no package.json found in ${root} (use --root to point at the project)`);
  }
  const ignorePaths = config.ignorePaths.map(globToRegExp);
  const files = opts.files.filter((f) => !matchesAny(toPosix(path.relative(root, f)), ignorePaths));
  const options = compilerOptions(root);
  const host = ts.createCompilerHost(options, true);
  const program = ts.createProgram({ rootNames: files, options, host });
  const project = new Project(root, config, program, options, host);
  let checked = 0;
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    checked++;
    new FileChecker(project, sf).run();
  }
  const findings = project.findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule),
  );
  return {
    version: 1,
    root,
    filesChecked: checked,
    findings,
    summary: {
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
    },
  };
}

class Project {
  readonly findings: Finding[] = [];
  readonly checker: ts.TypeChecker;
  readonly deps: ProjectDeps;
  private readonly seen = new Set<string>();
  private readonly moduleCache = new Map<ts.Symbol, ModuleExports | null>();
  private readonly resolutionCache: ts.ModuleResolutionCache;

  constructor(
    readonly root: string,
    readonly config: Config,
    readonly program: ts.Program,
    readonly options: ts.CompilerOptions,
    readonly host: ts.CompilerHost,
  ) {
    this.checker = program.getTypeChecker();
    this.deps = new ProjectDeps(root);
    this.resolutionCache = ts.createModuleResolutionCache(root, (f) => f, options);
  }

  resolveWithTs(spec: string, containingFile: string): ts.ResolvedModuleFull | undefined {
    return ts.resolveModuleName(spec, containingFile, this.options, this.host, this.resolutionCache).resolvedModule;
  }

  add(finding: Finding): void {
    if (!isRuleId(finding.rule)) return;
    if (this.config.ignoreRules.includes(finding.rule)) return;
    if (finding.package && this.config.ignorePackages.includes(finding.package)) return;
    const override = this.config.severity[finding.rule];
    if (override === "off") return;
    finding.severity = override ?? DEFAULT_SEVERITY[finding.rule];
    const key = `${finding.file}:${finding.line}:${finding.column}:${finding.rule}:${finding.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.findings.push(finding);
  }

  moduleExports(symbol: ts.Symbol): ModuleExports | undefined {
    let cached = this.moduleCache.get(symbol);
    if (cached === undefined) {
      cached = this.computeModuleExports(symbol);
      this.moduleCache.set(symbol, cached);
    }
    return cached ?? undefined;
  }

  private computeModuleExports(symbol: ts.Symbol): ModuleExports | null {
    const decls = symbol.declarations ?? [];
    if (decls.length === 0) return null;
    let file: ts.SourceFile | undefined;
    for (const d of decls) {
      if (ts.isSourceFile(d)) {
        if (JS_FILE.test(d.fileName)) return null;
        file = d;
      } else if (ts.isModuleDeclaration(d)) {
        if (!d.body) return null; // shorthand ambient module: shape unknown
        file = d.getSourceFile();
      } else {
        return null;
      }
    }
    if (!file || this.hasUnresolvedStar(symbol, new Set())) return null;
    const names = new Set<string>();
    for (const s of this.checker.getExportsOfModule(symbol)) names.add(s.name);
    let exportEquals = false;
    const eq = symbol.exports?.get(ts.InternalSymbolName.ExportEquals);
    if (eq) {
      exportEquals = true;
      names.delete(ts.InternalSymbolName.ExportEquals);
      const target = eq.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(eq) : eq;
      const type = this.checker.getTypeOfSymbol(target);
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return null;
      for (const p of type.getProperties()) names.add(p.name);
      for (const s of target.exports?.values() ?? []) names.add(s.name);
    }
    return { names, exportEquals, file };
  }

  private hasUnresolvedStar(symbol: ts.Symbol, seen: Set<ts.Symbol>): boolean {
    if (seen.has(symbol)) return false;
    seen.add(symbol);
    for (const d of symbol.declarations ?? []) {
      const container = ts.isSourceFile(d) ? d : ts.isModuleDeclaration(d) && d.body && ts.isModuleBlock(d.body) ? d.body : undefined;
      if (!container) continue;
      for (const st of container.statements) {
        if (ts.isExportDeclaration(st) && !st.exportClause && st.moduleSpecifier) {
          const target = this.checker.getSymbolAtLocation(st.moduleSpecifier);
          if (!target || this.hasUnresolvedStar(target, seen)) return true;
        }
      }
    }
    return false;
  }
}

interface ModuleExports {
  names: Set<string>;
  exportEquals: boolean;
  file: ts.SourceFile;
}

const RELATIVE_EXT = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".node"];
const INDEX_FILES = RELATIVE_EXT.map((e) => "index" + e);
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"],
};

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function relativeTargetExists(target: string): boolean {
  if (isFile(target)) return true;
  if (RELATIVE_EXT.some((e) => isFile(target + e))) return true;
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  if ((JS_TO_TS[ext] ?? []).some((e) => isFile(stem + e))) return true;
  if (isDir(target)) {
    return isFile(path.join(target, "package.json")) || INDEX_FILES.some((i) => isFile(path.join(target, i)));
  }
  return false;
}

class FileChecker {
  private readonly checker: ts.TypeChecker;
  private readonly file: string;
  private readonly relFile: string;
  private readonly suppressions: Suppressions;
  private readonly declared: Set<string>;

  constructor(
    private readonly project: Project,
    private readonly sf: ts.SourceFile,
  ) {
    this.checker = project.checker;
    this.file = sf.fileName;
    this.relFile = toPosix(path.relative(project.root, sf.fileName));
    this.suppressions = parseSuppressions(sf.text);
    this.declared = project.deps.declaredFor(sf.fileName);
  }

  run(): void {
    this.visit(this.sf);
  }

  private visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const ok = this.moduleRef(node.moduleSpecifier, node.importClause?.isTypeOnly ? "types" : "import");
      if (ok) this.checkImportClause(node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const ok = this.moduleRef(node.moduleSpecifier, node.isTypeOnly ? "types" : "import");
      if (ok) this.checkExportSpecifiers(node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      this.moduleRef(node.moduleReference.expression, node.isTypeOnly ? "types" : "require");
    } else if (ts.isCallExpression(node)) {
      this.dynamicModuleRef(node);
    } else if (ts.isPropertyAccessExpression(node)) {
      this.checkNamespaceMember(node);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) this.checkCall(node);
    else if (ts.isIdentifier(node)) this.checkDeprecated(node);
    ts.forEachChild(node, (child) => this.visit(child));
  }

  private dynamicModuleRef(node: ts.CallExpression): void {
    const arg = node.arguments[0];
    if (!arg || !ts.isStringLiteralLike(arg) || node.arguments.length < 1) return;
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      this.moduleRef(arg, "import");
    } else if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) {
      const sym = this.checker.getSymbolAtLocation(node.expression);
      const local = sym?.declarations?.some((d) => !d.getSourceFile().hasNoDefaultLib && !inNodeModules(d.getSourceFile().fileName));
      if (!local) this.moduleRef(arg, "require");
    }
  }

  report(node: ts.Node, rule: string, message: string, extra: Partial<Pick<Finding, "package" | "symbol" | "suggestion">> = {}): void {
    const start = node.getStart(this.sf);
    const pos = this.sf.getLineAndCharacterOfPosition(start);
    const lines = [pos.line + 1, this.statementLine(node)];
    if (isSuppressed(this.suppressions, lines, rule)) return;
    const finding: Finding = {
      rule,
      severity: "error",
      file: this.relFile,
      line: pos.line + 1,
      column: pos.character + 1,
      message,
    };
    if (extra.package !== undefined) finding.package = extra.package;
    if (extra.symbol !== undefined) finding.symbol = extra.symbol;
    if (extra.suggestion !== undefined) finding.suggestion = extra.suggestion;
    this.project.add(finding);
  }

  private statementLine(node: ts.Node): number {
    let current: ts.Node = node;
    while (current.parent && !ts.isSourceFile(current.parent) && !ts.isBlock(current.parent) && !ts.isModuleBlock(current.parent)) {
      current = current.parent;
    }
    return this.sf.getLineAndCharacterOfPosition(current.getStart(this.sf)).line + 1;
  }

  /** Checks a module specifier. Returns true when it is fine and further checks make sense. */
  private moduleRef(specNode: ts.Expression, kind: ImportKind): boolean {
    if (!ts.isStringLiteralLike(specNode)) return true;
    const spec = specNode.text;
    if (spec.startsWith(".")) return this.relativeRef(specNode, spec);
    if (spec.startsWith("/") || spec.startsWith("#") || spec.includes(":")) return true;
    if (isBuiltin(spec)) return true;
    const parts = splitSpecifier(spec);
    if (!parts) return true;
    const { name, subpath } = parts;
    if (this.project.config.ignorePackages.includes(name)) return false;

    const resolved = this.project.resolveWithTs(spec, this.file);
    if (resolved && !resolved.isExternalLibraryImport && !inNodeModules(resolved.resolvedFileName)) {
      return true; // tsconfig path alias, baseUrl import or linked workspace source
    }

    if (this.project.deps.isWorkspacePackage(name)) return true;
    const declared = this.declared.has(name);
    const installed = findInstalled(path.dirname(this.file), name);
    if (!declared) {
      const suggestion = closest(name, [...this.declared].filter((d) => !isBuiltin(d)));
      const message = installed
        ? `"${name}" is installed but not declared in package.json (transitive dependency?)`
        : `"${name}" is not declared in package.json and not installed; the package may not exist (typo or invented name; importing unknown names is a supply-chain risk)`;
      this.report(specNode, "unknown-package", message, {
        package: name,
        ...(suggestion ? { suggestion } : {}),
      });
      return false;
    }
    if (!installed) {
      this.report(specNode, "not-installed", `"${name}" is declared in package.json but not found in node_modules; its exports cannot be verified`, {
        package: name,
      });
      return false;
    }

    const json = installed.json;
    if (json.exports !== undefined && json.exports !== null && !installed.viaTypes) {
      const outcome = resolveExports(json.exports, subpath, kind, installed.dir);
      if (!outcome.ok) {
        const full = spec;
        const why =
          outcome.reason === "no-condition"
            ? `has no "${kind === "require" ? "require" : "import"}" condition for this subpath`
            : outcome.reason === "file-missing"
              ? `maps to a file that does not exist`
              : outcome.reason === "blocked"
                ? `is blocked by the "exports" map`
                : `is not defined in the "exports" map`;
        const keyNames = outcome.keys.map((k) => (k === "." ? name : name + k.slice(1)));
        const suggestion = subpath === "." ? undefined : closest(full, keyNames);
        this.report(specNode, "unresolved-subpath", `"${full}" ${why} of ${name}`, {
          package: name,
          ...(suggestion ? { suggestion } : {}),
        });
        return false;
      }
    } else if (subpath !== "." && json.typesVersions === undefined && !subpathExistsOnDisk(installed.dir, subpath)) {
      this.report(specNode, "unresolved-subpath", `"${spec}": no file or directory "${subpath.slice(2)}" in installed ${name}`, {
        package: name,
      });
      return false;
    }
    return true;
  }

  private relativeRef(specNode: ts.Expression, spec: string): boolean {
    const clean = spec.split(/[?#]/)[0]!;
    const target = path.resolve(path.dirname(this.file), clean);
    if (relativeTargetExists(target)) return true;
    const dir = path.dirname(target);
    let siblings: string[] = [];
    try {
      siblings = fs.readdirSync(dir).map((n) => n.replace(/(\.d)?\.[cm]?[jt]sx?$/, ""));
    } catch {
      /* directory missing too */
    }
    const base = path.basename(target).replace(/(\.d)?\.[cm]?[jt]sx?$/, "");
    const near = closest(base, siblings);
    this.report(specNode, "relative-import-missing", `Cannot find "${spec}" (resolved to ${toPosix(path.relative(this.project.root, target))})`, {
      ...(near ? { suggestion: `${path.posix.dirname(clean)}/${near}`.replace(/^\.\/\.\.\//, "../") } : {}),
    });
    return false;
  }

  private packageOf(specNode: ts.Expression): string | undefined {
    if (!ts.isStringLiteralLike(specNode)) return undefined;
    const spec = specNode.text;
    if (spec.startsWith(".")) return undefined;
    return splitSpecifier(spec)?.name;
  }

  private checkImportClause(node: ts.ImportDeclaration): void {
    const clause = node.importClause;
    if (!clause) return;
    const modSym = this.checker.getSymbolAtLocation(node.moduleSpecifier);
    if (!modSym) return;
    const info = this.project.moduleExports(modSym);
    if (!info) return;
    const pkg = this.packageOf(node.moduleSpecifier);
    if (clause.name) {
      this.checkDefault(clause.name, node.moduleSpecifier, info, pkg);
    }
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) this.checkExportName(el, (el.propertyName ?? el.name).text, node.moduleSpecifier, info, pkg);
    }
  }

  private checkExportSpecifiers(node: ts.ExportDeclaration): void {
    if (!node.moduleSpecifier || !node.exportClause || !ts.isNamedExports(node.exportClause)) return;
    const modSym = this.checker.getSymbolAtLocation(node.moduleSpecifier);
    const info = modSym && this.project.moduleExports(modSym);
    if (!info) return;
    const pkg = this.packageOf(node.moduleSpecifier);
    for (const el of node.exportClause.elements) {
      this.checkExportName(el, (el.propertyName ?? el.name).text, node.moduleSpecifier, info, pkg);
    }
  }

  private checkExportName(at: ts.Node, name: string, specNode: ts.Expression, info: ModuleExports, pkg: string | undefined): void {
    if (info.names.has(name)) return;
    const spec = ts.isStringLiteralLike(specNode) ? specNode.text : "module";
    const suggestion = closest(name, [...info.names].filter((n) => n !== "default"));
    this.report(at, "missing-export", `"${name}" is not exported by "${spec}"`, {
      symbol: name,
      ...(pkg ? { package: pkg } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }

  private checkDefault(at: ts.Node, specNode: ts.Expression, info: ModuleExports, pkg: string | undefined): void {
    if (info.names.has("default") || info.exportEquals) return;
    if (!this.isEsmDeclaration(info.file)) return;
    const spec = ts.isStringLiteralLike(specNode) ? specNode.text : "module";
    this.report(at, "missing-export", `"${spec}" has no default export`, {
      symbol: "default",
      ...(pkg ? { package: pkg } : {}),
    });
  }

  /** Default-import checks are only reliable when the module is known to be an ES module. */
  private isEsmDeclaration(file: ts.SourceFile): boolean {
    const name = file.fileName;
    if (/\.(d\.)?mts$/.test(name)) return true;
    if (/\.(d\.)?cts$/.test(name)) return false;
    if (!inNodeModules(name)) return /\.tsx?$/.test(name);
    for (let dir = path.dirname(name); ; dir = path.dirname(dir)) {
      const json = readPackageJson(path.join(dir, "package.json"));
      if (json) return json.type === "module";
      if (path.dirname(dir) === dir) return false;
    }
  }

  private rangeOf(sig: ts.Signature): ArgRange | undefined {
    const decl = sig.declaration;
    if (!decl || ts.isJSDocSignature(decl)) return undefined;
    const params = decl.parameters.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"));
    let min = 0;
    let max = params.length;
    params.forEach((p, i) => {
      if (p.dotDotDotToken) max = Infinity;
      else if (!p.questionToken && !p.initializer) min = i + 1;
    });
    while (min > 0) {
      const p = params[min - 1]!;
      if (!p.type) break;
      const t = this.checker.getTypeFromTypeNode(p.type);
      const acceptsVoid = t.flags & ts.TypeFlags.Void || (t.isUnion() && t.types.some((u) => u.flags & ts.TypeFlags.Void));
      if (!acceptsVoid) break;
      min--;
    }
    return { min, max };
  }

  private checkCall(node: ts.CallExpression | ts.NewExpression): void {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.kind === ts.SyntaxKind.SuperKeyword) return;
    const type = this.checker.getNonNullableType(this.checker.getTypeAtLocation(node.expression));
    const sigs = ts.isNewExpression(node) ? type.getConstructSignatures() : type.getCallSignatures();
    if (sigs.length === 0 || !sigs.every((s) => isExternalDecl(s.declaration))) return;
    const args = node.arguments ? [...node.arguments] : [];
    const pkg = packageNameFromPath(sigs[0]!.declaration!.getSourceFile().fileName);
    const name = node.expression.getText(this.sf).replace(/\s+/g, " ").slice(0, 60);
    const ranges = sigs.map((s) => this.rangeOf(s));
    if (ranges.some((r) => r === undefined)) return;
    const known = ranges as ArgRange[];
    const spread = args.some((a) => ts.isSpreadElement(a));
    const compatible = sigs.filter((_, i) => spread || (args.length >= known[i]!.min && args.length <= known[i]!.max));
    if (!spread && compatible.length === 0) {
      this.report(node, "bad-call-arity", `${name}() called with ${args.length} argument${args.length === 1 ? "" : "s"}, but it accepts ${describeRanges(known)}`, {
        symbol: name,
        ...(pkg ? { package: pkg } : {}),
      });
      return;
    }
    args.forEach((arg, index) => {
      if (!ts.isObjectLiteralExpression(arg)) return;
      const types: ts.Type[] = [];
      for (const sig of compatible) {
        const param = sig.getParameters()[index];
        const decl = param?.valueDeclaration;
        if (!param || (decl && ts.isParameter(decl) && decl.dotDotDotToken)) continue;
        types.push(this.checker.getTypeOfSymbolAtLocation(param, arg));
      }
      if (types.length > 0) this.checkObjectLiteral(arg, types, `${name}()`, pkg, 0);
    });
  }

  private collectKeys(type: ts.Type, acc: KeySet, depth: number): void {
    if (depth > 6) {
      acc.open = true;
      return;
    }
    if (type.isUnion() || type.isIntersection()) {
      for (const t of type.types) this.collectKeys(t, acc, depth + 1);
      return;
    }
    const F = ts.TypeFlags;
    if (type.flags & (F.Any | F.Unknown | F.TypeParameter | F.IndexedAccess | F.Conditional | F.Substitution | F.NonPrimitive)) {
      acc.open = true;
      return;
    }
    if (!(type.flags & F.Object)) return;
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return;
    const symbolName = type.symbol?.name;
    if (symbolName === "Array" || symbolName === "ReadonlyArray") return;
    if (symbolName === "Object" || this.checker.getIndexInfosOfType(type).length > 0) {
      acc.open = true;
      return;
    }
    const props = type.getProperties();
    if (props.length === 0) {
      acc.open = true;
      return;
    }
    acc.sawObject = true;
    for (const p of props) acc.keys.add(p.name);
  }

  private propertySymbols(type: ts.Type, name: string, out: ts.Symbol[]): void {
    if (type.isUnion() || type.isIntersection()) {
      for (const t of type.types) this.propertySymbols(t, name, out);
      return;
    }
    const sym = type.getProperty(name);
    if (sym) out.push(sym);
  }

  private checkObjectLiteral(lit: ts.ObjectLiteralExpression, types: ts.Type[], callName: string, pkg: string | undefined, depth: number): void {
    const acc: KeySet = { keys: new Set(), open: false, sawObject: false };
    for (const t of types) this.collectKeys(this.checker.getNonNullableType(t), acc, 0);
    if (acc.open || !acc.sawObject) return;
    for (const prop of lit.properties) {
      const key = propertyName(prop);
      if (key === undefined || !prop.name) continue;
      if (!acc.keys.has(key)) {
        const suggestion = closest(key, acc.keys);
        const valid = [...acc.keys].sort();
        const hint = suggestion ? `; did you mean "${suggestion}"?` : valid.length <= 12 ? ` (known keys: ${valid.join(", ")})` : "";
        this.report(prop.name, "unknown-option-key", `Unknown option "${key}" passed to ${callName}${hint}`, {
          symbol: key,
          ...(pkg ? { package: pkg } : {}),
          ...(suggestion ? { suggestion } : {}),
        });
        continue;
      }
      const symbols: ts.Symbol[] = [];
      for (const t of types) this.propertySymbols(this.checker.getNonNullableType(t), key, symbols);
      const deprecated = symbols.flatMap((s) => s.getJsDocTags(this.checker)).find((t) => t.name === "deprecated");
      if (deprecated) {
        this.report(prop.name, "deprecated-api", this.deprecationMessage(`option "${key}" of ${callName}`, deprecated), {
          symbol: key,
          ...(pkg ? { package: pkg } : {}),
        });
      }
      if (depth < 3 && ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
        const nested = symbols.map((s) => this.checker.getTypeOfSymbolAtLocation(s, lit));
        if (nested.length > 0) this.checkObjectLiteral(prop.initializer, nested, `${callName} option "${key}"`, pkg, depth + 1);
      }
    }
  }

  private deprecationMessage(what: string, tag: ts.JSDocTagInfo): string {
    const text = ts.displayPartsToString(tag.text).trim();
    return text ? `${what} is deprecated: ${text}` : `${what} is deprecated`;
  }

  private calleeCall(node: ts.Identifier): ts.CallExpression | ts.NewExpression | undefined {
    let n: ts.Node = node;
    if (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
    const p = n.parent;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) return p;
    return undefined;
  }

  private checkDeprecated(node: ts.Identifier): void {
    const parent = node.parent;
    if (
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent) ||
      ts.isExportSpecifier(parent) ||
      ts.isImportEqualsDeclaration(parent)
    ) {
      return;
    }
    const sym = this.checker.getSymbolAtLocation(node);
    if (!sym) return;
    let target = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        target = this.checker.getAliasedSymbol(sym);
      } catch {
        return;
      }
    }
    const decls = target.declarations ?? [];
    if (decls.length === 0 || !decls.every(isExternalDecl)) return;
    const tags: ts.JSDocTagInfo[] = [];
    const call = this.calleeCall(node);
    const overloaded = decls.filter(isFunctionLike).length > 1;
    if (call) {
      const sig = this.checker.getResolvedSignature(call);
      if (sig && isExternalDecl(sig.declaration)) tags.push(...sig.getJsDocTags());
    }
    if (!(call && overloaded)) tags.push(...target.getJsDocTags(this.checker));
    const deprecated = tags.find((t) => t.name === "deprecated");
    if (!deprecated) return;
    const pkg = packageNameFromPath(decls[0]!.getSourceFile().fileName);
    this.report(node, "deprecated-api", this.deprecationMessage(`"${node.text}"`, deprecated), {
      symbol: node.text,
      ...(pkg ? { package: pkg } : {}),
    });
  }

  private checkNamespaceMember(node: ts.PropertyAccessExpression): void {
    if (!ts.isIdentifier(node.expression)) return;
    const sym = this.checker.getSymbolAtLocation(node.expression);
    const decl = sym?.declarations?.[0];
    if (!decl || !ts.isNamespaceImport(decl)) return;
    const importDecl = decl.parent.parent;
    if (!ts.isImportDeclaration(importDecl)) return;
    const modSym = this.checker.getSymbolAtLocation(importDecl.moduleSpecifier);
    const info = modSym && this.project.moduleExports(modSym);
    if (!info) return;
    const name = node.name.text;
    if (info.names.has(name)) return;
    const spec = ts.isStringLiteralLike(importDecl.moduleSpecifier) ? importDecl.moduleSpecifier.text : "module";
    const suggestion = closest(name, [...info.names].filter((n) => n !== "default"));
    const pkg = this.packageOf(importDecl.moduleSpecifier);
    this.report(node.name, "missing-export", `"${name}" is not exported by "${spec}"`, {
      symbol: name,
      ...(pkg ? { package: pkg } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }
}

export { packageNameFromPath };

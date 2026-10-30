import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

export interface PackageJson {
  name?: string;
  type?: string;
  exports?: unknown;
  typesVersions?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

export const MAX_JSON_BYTES = 5 * 1024 * 1024;

/** True when `target` is `dir` itself or lies below it, lexically. */
export function isWithin(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const jsonCache = new Map<string, PackageJson | null>();

export function readPackageJson(file: string): PackageJson | undefined {
  let cached = jsonCache.get(file);
  if (cached === undefined) {
    try {
      if (fs.statSync(file).size > MAX_JSON_BYTES) throw new Error("package.json too large");
      cached = JSON.parse(fs.readFileSync(file, "utf8")) as PackageJson;
    } catch {
      cached = null;
    }
    jsonCache.set(file, cached);
  }
  return cached ?? undefined;
}

export function clearPackageCache(): void {
  jsonCache.clear();
}

const BUILTINS = new Set(builtinModules);

export function isBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || BUILTINS.has(spec);
}

export interface SpecifierParts {
  name: string;
  /** "." for the package root, otherwise "./sub/path". */
  subpath: string;
}

export function splitSpecifier(spec: string): SpecifierParts | undefined {
  const segs = spec.split("/");
  if (spec.startsWith("@")) {
    if (segs.length < 2 || !segs[0]!.slice(1) || !segs[1]) return undefined;
    const name = `${segs[0]}/${segs[1]}`;
    const rest = segs.slice(2).join("/");
    return { name, subpath: rest ? `./${rest}` : "." };
  }
  if (!segs[0]) return undefined;
  const rest = segs.slice(1).join("/");
  return { name: segs[0], subpath: rest ? `./${rest}` : "." };
}

/** `@types/foo` -> `foo`, `@types/scope__pkg` -> `@scope/pkg`. */
export function typesTarget(name: string): string | undefined {
  if (!name.startsWith("@types/")) return undefined;
  const rest = name.slice("@types/".length);
  const idx = rest.indexOf("__");
  return idx >= 0 ? `@${rest.slice(0, idx)}/${rest.slice(idx + 2)}` : rest;
}

export function typesPackageName(name: string): string {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.slice(1).split("/");
    return `@types/${scope}__${pkg}`;
  }
  return `@types/${name}`;
}

export interface InstalledPackage {
  dir: string;
  json: PackageJson;
  /** True when only the `@types/*` package was found. */
  viaTypes: boolean;
}

/** Finds an installed package by walking up `node_modules` directories from `fromDir`. */
export function findInstalled(fromDir: string, name: string): InstalledPackage | undefined {
  let types: InstalledPackage | undefined;
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const real = path.join(dir, "node_modules", name);
    const json = readPackageJson(path.join(real, "package.json"));
    if (json) return { dir: real, json, viaTypes: false };
    if (!types) {
      const typesDir = path.join(dir, "node_modules", typesPackageName(name));
      const typesJson = readPackageJson(path.join(typesDir, "package.json"));
      if (typesJson) types = { dir: typesDir, json: typesJson, viaTypes: true };
    }
    if (path.dirname(dir) === dir) break;
  }
  return types;
}

/** Package name for a file inside node_modules, or undefined. */
export function packageNameFromPath(file: string): string | undefined {
  const marker = "/node_modules/";
  const normalized = file.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf(marker);
  if (idx < 0) return undefined;
  const segs = normalized.slice(idx + marker.length).split("/");
  const name = segs[0]!.startsWith("@") ? `${segs[0]}/${segs[1]}` : segs[0]!;
  return typesTarget(name) ?? name;
}

function globDirs(root: string, pattern: string): string[] {
  const clean = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  if (clean.endsWith("/**")) return globDirs(root, clean.slice(0, -3) + "/*");
  const star = clean.indexOf("*");
  if (star < 0) {
    const dir = path.join(root, clean);
    return isWithin(root, dir) ? [dir] : [];
  }
  if (clean.slice(star) !== "*" || !clean.slice(0, star).endsWith("/")) return [];
  const base = path.join(root, clean.slice(0, star));
  if (!isWithin(root, base)) return [];
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, e.name));
  } catch {
    return [];
  }
}

/** What package.json files declare, for a project root. */
export class ProjectDeps {
  private readonly workspaceNames = new Set<string>();
  private readonly dirCache = new Map<string, Set<string>>();

  constructor(readonly root: string) {
    const rootJson = readPackageJson(path.join(root, "package.json"));
    const ws = rootJson?.workspaces;
    const patterns = Array.isArray(ws) ? ws : (ws?.packages ?? []);
    for (const pattern of patterns) {
      for (const dir of globDirs(root, pattern)) {
        const name = readPackageJson(path.join(dir, "package.json"))?.name;
        if (name) this.workspaceNames.add(name);
      }
    }
  }

  isWorkspacePackage(name: string): boolean {
    return this.workspaceNames.has(name);
  }

  /** Names declared by the package.json files between the file's directory and the root, plus own names. */
  declaredFor(file: string): Set<string> {
    const names = new Set<string>(this.workspaceNames);
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      for (const n of this.declaredInDir(dir)) names.add(n);
      if (dir === this.root || path.dirname(dir) === dir || !dir.startsWith(this.root)) break;
    }
    return names;
  }

  private declaredInDir(dir: string): Set<string> {
    let set = this.dirCache.get(dir);
    if (set) return set;
    set = new Set<string>();
    const json = readPackageJson(path.join(dir, "package.json"));
    if (json) {
      if (json.name) set.add(json.name);
      for (const field of [json.dependencies, json.devDependencies, json.peerDependencies, json.optionalDependencies]) {
        for (const dep of Object.keys(field ?? {})) {
          set.add(dep);
          const target = typesTarget(dep);
          if (target) set.add(target);
        }
      }
    }
    this.dirCache.set(dir, set);
    return set;
  }
}

const LAYOUT_EXT = ["", ".js", ".json", ".mjs", ".cjs", ".ts", ".d.ts", ".d.mts", ".d.cts", ".tsx", ".node"];
const INDEX = ["index.js", "index.json", "index.mjs", "index.cjs", "index.ts", "index.d.ts", "index.node"];

/** File-layout check for packages without an `exports` map. */
export function subpathExistsOnDisk(pkgDir: string, subpath: string): boolean {
  const base = path.join(pkgDir, subpath);
  if (!isWithin(pkgDir, base)) return false;
  for (const ext of LAYOUT_EXT) {
    try {
      if (fs.statSync(base + ext).isFile()) return true;
    } catch {
      /* try next */
    }
  }
  try {
    if (fs.statSync(base).isDirectory()) {
      if (fs.existsSync(path.join(base, "package.json"))) return true;
      return INDEX.some((i) => fs.existsSync(path.join(base, i)));
    }
  } catch {
    /* not a directory */
  }
  return false;
}

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectFiles } from "../src/files.js";
import { parseSuppressions } from "../src/suppress.js";
import { check, cleanupProjects, createProject, git, initRepo, rules, run } from "./helpers.js";

afterEach(cleanupProjects);

const BAD = `import { postJson } from "tiny-http";\nconsole.log(postJson);\n`;

describe("inline suppression", () => {
  it("suppresses a named rule on the next line", () => {
    const src = `// refcheck-ignore missing-export\nimport { postJson } from "tiny-http";\nconsole.log(postJson);\n`;
    expect(check(src)).toEqual([]);
  });

  it("does not suppress other rules or other lines", () => {
    const src = `// refcheck-ignore unknown-package\nimport { postJson } from "tiny-http";\nimport { other } from "tiny-http";\nconsole.log(postJson, other);\n`;
    expect(rules(check(src))).toEqual(["missing-export", "missing-export"]);
  });

  it("supports several rules, a bare directive, trailing comments and reasons", () => {
    expect(check(`// refcheck-ignore unknown-package, missing-export -- generated\nimport { x } from "tiny-http";\nconsole.log(x);\n`)).toEqual([]);
    expect(check(`/* refcheck-ignore */\nimport { x } from "tiny-http";\nconsole.log(x);\n`)).toEqual([]);
    expect(check(`import { x } from "tiny-http"; // refcheck-ignore missing-export\nconsole.log(x);\n`)).toEqual([]);
  });

  it("applies to a whole multi-line statement", () => {
    const src = `import { get } from "tiny-http";\n// refcheck-ignore bad-call-arity\nget(\n  "a",\n  {},\n  "extra",\n);\n`;
    expect(check(src)).toEqual([]);
  });

  it("parses directives only from comments", () => {
    expect(parseSuppressions(`const s = "refcheck-ignore";\n`).size).toBe(0);
  });
});

describe("config", () => {
  it("ignoreRules drops a rule", () => {
    expect(check(BAD, { config: { ignoreRules: ["missing-export"] } })).toEqual([]);
  });

  it("severity overrides downgrade, upgrade and disable rules", () => {
    expect(check(BAD, { config: { severity: { "missing-export": "warning" } } })[0]!.severity).toBe("warning");
    const dep = `import { fetchUrl } from "tiny-http";\nfetchUrl("a");\n`;
    expect(check(dep, { config: { severity: { "deprecated-api": "error" } } })[0]!.severity).toBe("error");
    expect(check(dep, { config: { severity: { "deprecated-api": "off" } } })).toEqual([]);
  });

  it("ignorePaths excludes files from checking", () => {
    const project = createProject({ "src/gen/a.ts": BAD, "src/b.ts": BAD });
    const report = run(project, ["src/gen/a.ts", "src/b.ts"], { ignorePaths: ["src/gen/**"] });
    expect(report.filesChecked).toBe(1);
    expect(report.findings.map((f) => f.file)).toEqual(["src/b.ts"]);
  });

  it("ignorePackages drops findings about a package", () => {
    expect(check(`import { x } from "mystery-pkg";\nconsole.log(x);\n`, { config: { ignorePackages: ["mystery-pkg"] } })).toEqual([]);
  });
});

describe("file collection", () => {
  it("--all walks source files and skips node_modules, dist and dot directories", () => {
    const project = createProject({
      "src/a.ts": "",
      "src/b.tsx": "",
      "src/c.d.ts": "",
      "dist/x.js": "",
      ".hidden/y.ts": "",
      "readme.md": "",
    });
    const files = collectFiles({ root: project.root, cwd: project.root, paths: [], all: true, staged: false });
    expect(files.map((f) => path.relative(project.root, f))).toEqual(["src/a.ts", "src/b.tsx"]);
  });

  it("explicit paths accept files and directories and reject missing paths", () => {
    const project = createProject({ "src/a.ts": "", "src/sub/b.ts": "", "other/c.ts": "" });
    const files = collectFiles({ root: project.root, cwd: project.root, paths: ["src"], all: false, staged: false });
    expect(files.map((f) => path.relative(project.root, f))).toEqual(["src/a.ts", "src/sub/b.ts"]);
    expect(() => collectFiles({ root: project.root, cwd: project.root, paths: ["nope"], all: false, staged: false })).toThrow(/path not found/);
  });

  it("defaults to files changed versus HEAD, including untracked, excluding deleted", () => {
    const project = createProject({ "src/keep.ts": "export const k = 1;\n", "src/gone.ts": "export const g = 1;\n", "src/mod.ts": "export const m = 1;\n" });
    initRepo(project.root);
    git(project.root, "add", "-A");
    git(project.root, "commit", "-qm", "init");
    fs.appendFileSync(path.join(project.root, "src/mod.ts"), "export const m2 = 2;\n");
    fs.rmSync(path.join(project.root, "src/gone.ts"));
    project.write("src/new.ts", "export const n = 1;\n");
    const files = collectFiles({ root: project.root, cwd: project.root, paths: [], all: false, staged: false });
    expect(files.map((f) => path.relative(project.root, f))).toEqual(["src/mod.ts", "src/new.ts"]);
  });

  it("--staged returns only staged files", () => {
    const project = createProject({ "src/a.ts": "", "src/b.ts": "" });
    initRepo(project.root);
    git(project.root, "add", "src/a.ts");
    const files = collectFiles({ root: project.root, cwd: project.root, paths: [], all: false, staged: true });
    expect(files.map((f) => path.relative(project.root, f))).toEqual(["src/a.ts"]);
  });

  it("outside a git repository the default mode is a usage error", () => {
    const project = createProject({ "src/a.ts": "" });
    expect(() => collectFiles({ root: project.root, cwd: project.root, paths: [], all: false, staged: false })).toThrow(/git/);
  });
});

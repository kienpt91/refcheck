import { afterEach, describe, expect, it } from "vitest";
import { check, cleanupProjects, createProject, rules, run } from "./helpers.js";

afterEach(cleanupProjects);

describe("unknown-package", () => {
  it("flags an undeclared, uninstalled package and suggests the close declared name", () => {
    const f = check(`import { get } from "tiny-htpp";\nget("x");\n`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "unknown-package", severity: "error", package: "tiny-htpp", suggestion: "tiny-http", line: 1, column: 21 });
    expect(f[0]!.message).toContain("supply-chain");
  });

  it("gives no suggestion when nothing is close", () => {
    const f = check(`import x from "left-pad-pro";\nconsole.log(x);\n`);
    expect(f[0]).toMatchObject({ rule: "unknown-package" });
    expect(f[0]!.suggestion).toBeUndefined();
  });

  it("flags a scoped typo with a suggestion", () => {
    const f = check(`import { slugify } from "@acme/util";\nslugify("a");\n`);
    expect(f[0]).toMatchObject({ rule: "unknown-package", suggestion: "@acme/utils" });
  });

  it("flags an installed-but-undeclared (transitive) package", () => {
    const project = createProject({ "src/a.ts": `import x from "hidden-dep";\nconsole.log(x);\n` });
    project.install("hidden-dep", { main: "index.js" }, { "index.js": "module.exports = 1;" });
    const f = run(project, ["src/a.ts"]).findings;
    expect(f[0]).toMatchObject({ rule: "unknown-package" });
    expect(f[0]!.message).toContain("installed but not declared");
  });

  it("accepts node builtins, node: specifiers and declared packages", () => {
    const f = check(
      `import fs from "node:fs";\nimport { join } from "path";\nimport p from "fs/promises";\nimport { get } from "tiny-http";\nconsole.log(fs, join, p, get);\n`,
    );
    expect(f).toEqual([]);
  });

  it("accepts a package declared only through its @types package", () => {
    const project = createProject({ "src/a.ts": `import { x } from "typed-only";\nconsole.log(x);\n` }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", devDependencies: { "@types/typed-only": "1.0.0" } }));
    project.install("@types/typed-only", { types: "index.d.ts" }, { "index.d.ts": "export const x: number;" });
    expect(run(project, ["src/a.ts"]).findings).toEqual([]);
  });

  it("accepts workspace packages and tsconfig path aliases", () => {
    const project = createProject(
      {
        "packages/core/package.json": JSON.stringify({ name: "@mono/core", main: "src/index.ts" }),
        "packages/core/src/index.ts": "export const core = 1;\n",
        "apps/web/package.json": JSON.stringify({ name: "web" }),
        "apps/web/src/a.ts": `import { core } from "@mono/core";\nimport { helper } from "@app/helper";\nconsole.log(core, helper);\n`,
        "apps/web/src/helper.ts": "export const helper = 2;\n",
        "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["apps/web/src/*"] } } }),
      },
      { fixtures: false },
    );
    project.write("package.json", JSON.stringify({ name: "mono", workspaces: ["packages/*", "apps/*"] }));
    expect(run(project, ["apps/web/src/a.ts"]).findings).toEqual([]);
  });

  it("checks dynamic import() and require() specifiers", () => {
    const f = check(`export async function f() {\n  await import("nope-dyn");\n  return require("nope-req");\n}\n`);
    expect(rules(f)).toEqual(["unknown-package", "unknown-package"]);
    expect(f.map((x) => x.package)).toEqual(["nope-dyn", "nope-req"]);
  });
});

describe("not-installed", () => {
  it("warns when a declared package is missing from node_modules", () => {
    const f = check(`import { x } from "ghost-lib";\nconsole.log(x);\n`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "not-installed", severity: "warning", package: "ghost-lib" });
  });
});

describe("unresolved-subpath", () => {
  it("flags a subpath missing from the exports map", () => {
    const f = check(`import { x } from "@acme/utils/array";\nconsole.log(x);\n`);
    expect(f[0]).toMatchObject({ rule: "unresolved-subpath", package: "@acme/utils" });
  });

  it("accepts mapped and pattern subpaths", () => {
    const f = check(
      `import { slugify } from "@acme/utils/string";\nimport { enabled } from "@acme/utils/features/a";\nimport "tiny-http/package.json";\nconsole.log(slugify, enabled);\n`,
    );
    expect(f).toEqual([]);
  });

  it("flags a pattern subpath whose target file does not exist", () => {
    const f = check(`import { enabled } from "@acme/utils/features/zzz";\nconsole.log(enabled);\n`);
    expect(f[0]).toMatchObject({ rule: "unresolved-subpath" });
    expect(f[0]!.message).toContain("does not exist");
  });

  it("flags subpaths blocked with a null target", () => {
    const f = check(`import x from "@acme/utils/internal/secret";\nconsole.log(x);\n`);
    expect(f[0]).toMatchObject({ rule: "unresolved-subpath" });
    expect(f[0]!.message).toContain("blocked");
  });

  it("flags deep imports that bypass the exports map", () => {
    const f = check(`import type { InternalClient } from "tiny-http/dist/client";\nlet c: InternalClient | undefined = undefined;\nconsole.log(c);\n`);
    expect(f[0]).toMatchObject({ rule: "unresolved-subpath", package: "tiny-http" });
  });

  it("suggests the closest exported subpath", () => {
    const f = check(`import { x } from "@acme/utils/strings";\nconsole.log(x);\n`);
    expect(f[0]).toMatchObject({ rule: "unresolved-subpath", suggestion: "@acme/utils/string" });
  });

  it("respects import vs require conditions", () => {
    const project = createProject({}, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { "cond-pkg": "1.0.0" } }));
    project.install("cond-pkg", { exports: { ".": { import: "./esm.js" }, "./cjs": { require: "./cjs.cjs" } } });
    project.write("src/esm.ts", `import "cond-pkg/cjs";\n`);
    project.write("src/cjs.cts", `const x = require("cond-pkg/cjs");\nconsole.log(x);\n`);
    project.write("src/root.cts", `const x = require("cond-pkg");\nconsole.log(x);\n`);
    const r = run(project, ["src/esm.ts", "src/cjs.cts", "src/root.cts"]);
    expect(r.findings.map((f) => `${f.file}:${f.rule}`)).toEqual(["src/esm.ts:unresolved-subpath", "src/root.cts:unresolved-subpath"]);
    expect(r.findings[0]!.message).toContain(`no "import" condition`);
  });

  it("treats type-only imports as satisfied by either condition", () => {
    const project = createProject({}, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { "cond-pkg": "1.0.0" } }));
    project.install("cond-pkg", { exports: { "./cjs": { require: "./cjs.cjs" } } });
    project.write("src/a.ts", `import type {} from "cond-pkg/cjs";\n`);
    expect(run(project, ["src/a.ts"]).findings).toEqual([]);
  });

  it("falls back to file layout when there is no exports map", () => {
    const f = check(
      `import { createParseStream } from "csv-lite/lib/stream";\nimport nope from "csv-lite/lib/nope";\nconsole.log(createParseStream, nope);\n`,
    );
    expect(rules(f)).toEqual(["unresolved-subpath"]);
    expect(f[0]!.line).toBe(2);
  });
});

describe("relative-import-missing", () => {
  it("flags a relative import to a missing file and suggests a sibling", () => {
    const f = check(`import { x } from "./helpers";\nconsole.log(x);\n`, { files: { "src/helper.ts": "export const x = 1;\n" } });
    expect(f[0]).toMatchObject({ rule: "relative-import-missing", suggestion: "./helper" });
  });

  it("accepts existing files with .js, directory index and explicit extensions", () => {
    const f = check(`import { a } from "./a.js";\nimport { b } from "./lib";\nimport c from "./data.json";\nconsole.log(a, b, c);\n`, {
      files: { "src/a.ts": "export const a = 1;\n", "src/lib/index.ts": "export const b = 2;\n", "src/data.json": "{}" },
    });
    expect(f).toEqual([]);
  });

  it("flags missing assets and re-exports", () => {
    const f = check(`import "./style.css";\nexport * from "./gone";\n`);
    expect(rules(f)).toEqual(["relative-import-missing", "relative-import-missing"]);
  });
});

describe("path containment", () => {
  it("does not treat a subpath that climbs out of the package as existing", () => {
    const project = createProject({ "src/a.ts": `import x from "csv-lite/../plain-js/index";\nconsole.log(x);\n` });
    const f = run(project, ["src/a.ts"]).findings;
    expect(f.map((x) => x.rule)).toEqual(["unresolved-subpath"]);
  });

  it("ignores exports targets that point outside the package", () => {
    const project = createProject({ "src/a.ts": `import x from "esc-pkg/p/hosts";\nconsole.log(x);\n` }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { "esc-pkg": "1.0.0" } }));
    project.install("esc-pkg", { exports: { "./p/*": "./../../../package.json" } });
    expect(run(project, ["src/a.ts"]).findings.map((x) => x.rule)).toEqual(["unresolved-subpath"]);
  });

  it("does not follow workspace globs outside the root", () => {
    const project = createProject({ "src/a.ts": `import { x } from "outside-ws";\nconsole.log(x);\n` }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", workspaces: ["../*"] }));
    expect(run(project, ["src/a.ts"]).findings.map((x) => x.rule)).toEqual(["unknown-package"]);
  });
});

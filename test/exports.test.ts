import { afterEach, describe, expect, it } from "vitest";
import { check, cleanupProjects, createProject, rules, run } from "./helpers.js";

afterEach(cleanupProjects);

describe("missing-export", () => {
  it("flags an invented named import and suggests the closest export", () => {
    const f = check(`import { postJson } from "tiny-http";\nconsole.log(postJson);\n`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "missing-export", severity: "error", symbol: "postJson", package: "tiny-http", suggestion: "post", line: 1, column: 10 });
  });

  it("accepts existing values, types and aliased imports", () => {
    const f = check(
      `import { get, createClient as make, type RequestOptions } from "tiny-http";\nconst o: RequestOptions = {};\nconsole.log(get, make, o);\n`,
    );
    expect(f).toEqual([]);
  });

  it("flags only the missing specifier in a mixed import", () => {
    const f = check(`import { get, nope, post } from "tiny-http";\nconsole.log(get, nope, post);\n`);
    expect(f.map((x) => x.symbol)).toEqual(["nope"]);
  });

  it("follows re-exports through `export *` and `export { x } from`", () => {
    const ok = check(`import { slugify, formatDate, addDays, pad } from "@acme/utils";\nconsole.log(slugify, formatDate, addDays, pad);\n`);
    expect(ok).toEqual([]);
    const bad = check(`import { formatDates } from "@acme/utils";\nconsole.log(formatDates);\n`);
    expect(bad[0]).toMatchObject({ rule: "missing-export", suggestion: "formatDate" });
  });

  it("flags a missing member on a namespace import", () => {
    const f = check(`import * as http from "tiny-http";\nhttp.get("a");\nhttp.requestAll("b");\n`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "missing-export", symbol: "requestAll", line: 3 });
  });

  it("handles `export =` modules with merged namespaces", () => {
    const ok = check(`import parse from "csv-lite";\nimport { stringify } from "csv-lite";\nconsole.log(parse, stringify);\n`);
    expect(ok).toEqual([]);
    const bad = check(`import { parseAll } from "csv-lite";\nconsole.log(parseAll);\n`);
    expect(rules(bad)).toEqual(["missing-export"]);
  });

  it("flags a default import from an ES module that has no default export", () => {
    const f = check(`import http from "tiny-http";\nconsole.log(http);\n`);
    expect(f[0]).toMatchObject({ rule: "missing-export", symbol: "default" });
  });

  it("accepts a re-exported default", () => {
    expect(check(`import createStore, { Emitter } from "state-kit";\nconsole.log(createStore, Emitter);\n`)).toEqual([]);
  });

  it("checks `export { x } from` specifiers", () => {
    const f = check(`export { get, nada } from "tiny-http";\n`);
    expect(f.map((x) => x.symbol)).toEqual(["nada"]);
  });

  it("checks named imports from relative TypeScript modules", () => {
    const f = check(`import { present, absent } from "./local";\nconsole.log(present, absent);\n`, { files: { "src/local.ts": "export const present = 1;\n" } });
    expect(f.map((x) => `${x.rule}:${x.symbol}`)).toEqual(["missing-export:absent"]);
  });

  it("does not guess when the module has an unresolved `export *`", () => {
    const project = createProject({ "src/a.ts": `import { anything } from "star-pkg";\nconsole.log(anything);\n` }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { "star-pkg": "1.0.0" } }));
    project.install("star-pkg", { types: "index.d.ts" }, { "index.d.ts": `export * from "not-there";\nexport const one: number;\n` });
    expect(run(project, ["src/a.ts"]).findings).toEqual([]);
  });

  it("does not check packages without type declarations", () => {
    const project = createProject({ "src/a.ts": `import { whatever } from "untyped";\nconsole.log(whatever);\n` }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { untyped: "1.0.0" } }));
    project.install("untyped", { main: "index.js" }, { "index.js": "exports.real = 1;" });
    expect(run(project, ["src/a.ts"]).findings).toEqual([]);
  });

  it("does not check ambient shorthand modules", () => {
    const f = check(`import { anything } from "virtual-mod";\nconsole.log(anything);\n`, {
      files: { "src/ambient.d.ts": `declare module "virtual-mod";\n` },
    });
    expect(rules(f)).toEqual(["unknown-package"]); // undeclared, but no missing-export noise
  });
});

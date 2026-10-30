import { afterEach, describe, expect, it } from "vitest";
import { check, cleanupProjects, createProject, rules, run } from "./helpers.js";

afterEach(cleanupProjects);

describe("bad-call-arity", () => {
  it("flags too many arguments", () => {
    const f = check(`import { get } from "tiny-http";\nget("a", {}, "extra");\n`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "bad-call-arity", symbol: "get", package: "tiny-http", line: 2, column: 1 });
    expect(f[0]!.message).toContain("accepts 1-2");
  });

  it("flags too few arguments", () => {
    const f = check(`import { truncate } from "@acme/utils";\ntruncate("abc");\n`);
    expect(f[0]).toMatchObject({ rule: "bad-call-arity" });
    expect(f[0]!.message).toContain("accepts 2-3");
  });

  it("accepts optional and omitted parameters", () => {
    const f = check(`import { slugify, truncate } from "@acme/utils";\nslugify("a");\nslugify("a", { lower: true });\ntruncate("a", 3);\ntruncate("a", 3, "...");\n`);
    expect(f).toEqual([]);
  });

  it("considers every overload", () => {
    const ok = check(`import { pad } from "@acme/utils";\npad("a", 2);\npad("a", 2, "0");\n`);
    expect(ok).toEqual([]);
    const bad = check(`import { pad } from "@acme/utils";\npad("a");\npad("a", 2, "0", 1);\n`);
    expect(rules(bad)).toEqual(["bad-call-arity", "bad-call-arity"]);
    expect(bad[0]!.message).toContain("2 or 3");
  });

  it("accepts rest parameters and spread arguments", () => {
    const f = check(`import { Emitter } from "state-kit";\nconst e = new Emitter("x");\ne.emit("a", 1, 2, 3);\nconst args: string[] = [];\ne.emit("a", ...args);\n`);
    expect(f).toEqual([]);
  });

  it("checks constructors", () => {
    const f = check(`import { Emitter } from "state-kit";\nnew Emitter("a", "b");\n`);
    expect(f[0]).toMatchObject({ rule: "bad-call-arity", symbol: "Emitter" });
  });

  it("checks methods on values created by imported functions", () => {
    const f = check(`import { createClient } from "tiny-http";\nconst c = createClient("http://x");\nc.get();\n`);
    expect(f[0]).toMatchObject({ rule: "bad-call-arity", symbol: "c.get", package: "tiny-http" });
  });

  it("checks calls through a namespace import", () => {
    const f = check(`import * as http from "tiny-http";\nhttp.get();\n`);
    expect(f[0]).toMatchObject({ rule: "bad-call-arity", symbol: "http.get" });
  });

  it("treats trailing void-accepting parameters as optional", () => {
    const project = createProject({ "src/a.ts": `import { run } from "voidy";\nrun();\nrun(1);\n` }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { voidy: "1.0.0" } }));
    project.install("voidy", { types: "index.d.ts" }, { "index.d.ts": "export function run(value: void | number): void;" });
    expect(run(project, ["src/a.ts"]).findings).toEqual([]);
  });

  it("ignores functions that are not declared in node_modules", () => {
    const f = check(`import { local } from "./local";\nlocal(1, 2, 3);\nMath.max(1, 2, 3);\n[1].map((x) => x);\n`, {
      files: { "src/local.ts": "export function local(a: number): number { return a; }\n" },
    });
    expect(f).toEqual([]);
  });
});

describe("unknown-option-key", () => {
  it("flags a mis-cased key and suggests the real one", () => {
    const f = check(`import { createClient } from "tiny-http";\ncreateClient("u", { timeOut: 5 });\n`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "unknown-option-key", symbol: "timeOut", suggestion: "timeout", package: "tiny-http", line: 2, column: 21 });
  });

  it("flags an invented key without a close match and lists known keys", () => {
    const f = check(`import { slugify } from "@acme/utils";\nslugify("a", { fancy: true });\n`);
    expect(f[0]).toMatchObject({ rule: "unknown-option-key", symbol: "fancy" });
    expect(f[0]!.suggestion).toBeUndefined();
    expect(f[0]!.message).toContain("known keys: lower, separator");
  });

  it("accepts valid keys, including nested objects", () => {
    const f = check(`import { createClient } from "tiny-http";\ncreateClient("u", { timeout: 1, retries: 2, auth: { user: "a", pass: "b" } });\n`);
    expect(f).toEqual([]);
  });

  it("checks nested object literals", () => {
    const f = check(`import { createClient } from "tiny-http";\ncreateClient("u", { auth: { username: "a", pass: "b" } });\n`);
    expect(f[0]).toMatchObject({ rule: "unknown-option-key", symbol: "username", suggestion: "user" });
  });

  it("checks options passed to methods of imported values", () => {
    const f = check(`import { createClient } from "tiny-http";\nconst c = createClient("u");\nc.get("/", { header: {} });\n`);
    expect(f[0]).toMatchObject({ rule: "unknown-option-key", symbol: "header", suggestion: "headers" });
  });

  it("does not flag index-signature, open and generic parameter types", () => {
    const project = createProject({
      "src/a.ts": `import { loose, anyOpts, record, generic } from "opts";\nloose({ whatever: 1 });\nanyOpts({ whatever: 1 });\nrecord({ whatever: 1 });\ngeneric({ whatever: 1 });\n`,
    }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { opts: "1.0.0" } }));
    project.install("opts", { types: "index.d.ts" }, {
      "index.d.ts": `export function loose(o: { [k: string]: unknown; a?: number }): void;
export function anyOpts(o: any): void;
export function record(o: Record<string, number>): void;
export function generic<T>(o: T): void;
`,
    });
    expect(run(project, ["src/a.ts"]).findings).toEqual([]);
  });

  it("accepts a key valid in any overload and ignores computed or spread keys", () => {
    const project = createProject({
      "src/a.ts": `import { ov } from "ov";\nconst extra = { zzz: 1 };\nov("a", { first: 1 });\nov({ second: 1 });\nov({ ...extra, ["c" + "k"]: 1, second: 2 });\n`,
    }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { ov: "1.0.0" } }));
    project.install("ov", { types: "index.d.ts" }, {
      "index.d.ts": `export function ov(name: string, o: { first?: number }): void;\nexport function ov(o: { second?: number }): void;\n`,
    });
    expect(run(project, ["src/a.ts"]).findings).toEqual([]);
  });

  it("flags a key that is invalid in every overload", () => {
    const project = createProject({ "src/a.ts": `import { ov } from "ov";\nov({ third: 1 });\n` }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { ov: "1.0.0" } }));
    project.install("ov", { types: "index.d.ts" }, {
      "index.d.ts": `export function ov(name: string, o: { first?: number }): void;\nexport function ov(o: { second?: number }): void;\n`,
    });
    expect(rules(run(project, ["src/a.ts"]).findings)).toEqual(["unknown-option-key"]);
  });
});

describe("deprecated-api", () => {
  it("warns on a deprecated imported function with its message", () => {
    const f = check(`import { fetchUrl } from "tiny-http";\nfetchUrl("a");\n`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "deprecated-api", severity: "warning", symbol: "fetchUrl", package: "tiny-http", line: 2 });
    expect(f[0]!.message).toContain("Use `get` instead");
  });

  it("warns on a deprecated class at construction", () => {
    const f = check(`import { OldStore } from "state-kit";\nnew OldStore({});\n`);
    expect(f[0]).toMatchObject({ rule: "deprecated-api", symbol: "OldStore" });
    expect(f[0]!.message).toContain("Use createStore instead");
  });

  it("warns on a deprecated option key", () => {
    const f = check(`import { get } from "tiny-http";\nget("a", { maxWait: 10 });\n`);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ rule: "deprecated-api", symbol: "maxWait" });
    expect(f[0]!.message).toContain("Use `timeout` instead");
  });

  it("warns through a namespace import", () => {
    const f = check(`import * as dates from "@acme/utils/date";\ndates.dateString(new Date());\n`);
    expect(f[0]).toMatchObject({ rule: "deprecated-api", symbol: "dateString" });
  });

  it("does not warn on non-deprecated symbols", () => {
    expect(check(`import { get, createClient } from "tiny-http";\nget("a", { timeout: 1 });\ncreateClient("x");\n`)).toEqual([]);
  });

  it("distinguishes deprecated overloads", () => {
    const project = createProject({ "src/a.ts": `import { f } from "ovl";\nf("a");\nf(1);\n` }, { fixtures: false });
    project.write("package.json", JSON.stringify({ name: "p", dependencies: { ovl: "1.0.0" } }));
    project.install("ovl", { types: "index.d.ts" }, {
      "index.d.ts": `/** @deprecated string form */\nexport function f(a: string): void;\nexport function f(a: number): void;\n`,
    });
    const f = run(project, ["src/a.ts"]).findings;
    expect(f.map((x) => `${x.rule}:${x.line}`)).toEqual(["deprecated-api:2"]);
  });
});

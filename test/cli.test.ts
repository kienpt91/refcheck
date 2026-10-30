import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli.js";
import type { Report } from "../src/types.js";
import { cleanupProjects, createProject, git, initRepo } from "./helpers.js";

afterEach(cleanupProjects);

function runCli(args: string[], cwd: string, tty = false): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: Io = { stdout: (t) => (out += t), stderr: (t) => (err += t), isTTY: tty, env: {} };
  const code = main(args, io, cwd);
  return { code, out, err };
}

const BAD = `import { postJson, get } from "tiny-http";\nconsole.log(postJson, get);\n`;
const GOOD = `import { get } from "tiny-http";\nconsole.log(get);\n`;
const DEPRECATED = `import { fetchUrl } from "tiny-http";\nfetchUrl("a");\n`;

describe("exit codes", () => {
  it("returns 0 when everything is fine", () => {
    const p = createProject({ "src/a.ts": GOOD });
    expect(runCli(["check", "src/a.ts"], p.root).code).toBe(0);
  });

  it("returns 1 when there is an error", () => {
    const p = createProject({ "src/a.ts": BAD });
    expect(runCli(["check", "src/a.ts"], p.root).code).toBe(1);
  });

  it("returns 0 when there are only warnings", () => {
    const p = createProject({ "src/a.ts": DEPRECATED });
    const r = runCli(["check", "src/a.ts", "--json"], p.root);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as Report).summary).toEqual({ errors: 0, warnings: 1 });
  });

  it("returns 2 for usage errors", () => {
    const p = createProject({ "src/a.ts": GOOD });
    expect(runCli([], p.root).code).toBe(2);
    expect(runCli(["bogus"], p.root).code).toBe(2);
    expect(runCli(["check", "--nope"], p.root).code).toBe(2);
    expect(runCli(["check", "missing.ts"], p.root).code).toBe(2);
    expect(runCli(["check", "--staged", "--all"], p.root).code).toBe(2);
    expect(runCli(["check", "--root"], p.root).code).toBe(2);
  });

  it("returns 2 when the root has no package.json or the config is invalid", () => {
    const empty = createProject({ "src/a.ts": GOOD }, { fixtures: false });
    const r = runCli(["check", "src/a.ts"], empty.root);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no package.json");
    const p = createProject({ "src/a.ts": GOOD, "refcheck.config.json": `{"ignoreRules":["nope"]}` });
    expect(runCli(["check", "src/a.ts"], p.root).code).toBe(2);
    p.write("refcheck.config.json", "{ not json");
    expect(runCli(["check", "src/a.ts"], p.root).err).toContain("invalid JSON");
  });

  it("prints help and version with exit 0", () => {
    const p = createProject();
    expect(runCli(["--help"], p.root)).toMatchObject({ code: 0 });
    const v = runCli(["--version"], p.root);
    expect(v.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("--json contract", () => {
  it("prints exactly one JSON object with the documented shape", () => {
    const p = createProject({ "src/a.ts": BAD });
    const r = runCli(["check", "src/a.ts", "--json"], p.root);
    const report = JSON.parse(r.out) as Report;
    expect(Object.keys(report).sort()).toEqual(["filesChecked", "findings", "root", "summary", "version"]);
    expect(report.version).toBe(1);
    expect(report.root).toBe(p.root);
    expect(report.filesChecked).toBe(1);
    expect(report.summary).toEqual({ errors: 1, warnings: 0 });
    expect(report.findings).toHaveLength(1);
    const f = report.findings[0]!;
    expect(f).toMatchObject({ rule: "missing-export", severity: "error", file: "src/a.ts", line: 1, column: 10, package: "tiny-http", symbol: "postJson" });
    expect(typeof f.message).toBe("string");
    expect(r.err).toBe("");
  });

  it("honors --root from another working directory and relative output paths", () => {
    const p = createProject({ "src/a.ts": BAD });
    const other = createProject({}, { fixtures: false });
    const r = runCli(["check", path.join(p.root, "src/a.ts"), "--root", p.root, "--json"], other.root);
    expect((JSON.parse(r.out) as Report).findings[0]!.file).toBe("src/a.ts");
  });

  it("emits an empty, valid report when there is nothing to check", () => {
    const p = createProject();
    initRepo(p.root);
    const r = runCli(["check", "--json"], p.root);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ version: 1, filesChecked: 0, findings: [], summary: { errors: 0, warnings: 0 } });
  });
});

describe("human output", () => {
  it("groups findings by file without colors when not a TTY", () => {
    const p = createProject({ "src/a.ts": BAD, "src/b.ts": GOOD });
    const r = runCli(["check", "src"], p.root);
    expect(r.out).toContain("src/a.ts\n");
    expect(r.out).toContain(`"postJson" is not exported by "tiny-http"`);
    expect(r.out).toContain(`did you mean "post"?`);
    expect(r.out).toContain("2 files checked, 1 error, 0 warnings");
    expect(r.out).not.toContain("\u001b[");
  });

  it("uses colors on a TTY unless --no-color is given", () => {
    const p = createProject({ "src/a.ts": BAD });
    expect(runCli(["check", "src/a.ts"], p.root, true).out).toContain("\u001b[");
    expect(runCli(["check", "src/a.ts", "--no-color"], p.root, true).out).not.toContain("\u001b[");
  });

  it("reports a clean run", () => {
    const p = createProject({ "src/a.ts": GOOD });
    expect(runCli(["check", "src/a.ts"], p.root).out).toContain("no problems found");
  });
});

describe("built CLI smoke test", () => {
  const repo = path.resolve(import.meta.dirname, "..");
  const cli = path.join(repo, "dist/cli.js");

  beforeAll(() => {
    const tsc = path.join(repo, "node_modules/typescript/bin/tsc");
    const built = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: repo, encoding: "utf8" });
    if (built.status !== 0) throw new Error(`build failed: ${built.stdout}${built.stderr}`);
  }, 120_000);

  it("runs end to end in a temp project via a spawned process", () => {
    const p = createProject({ "src/a.ts": BAD, "src/ok.ts": GOOD });
    initRepo(p.root);
    const bad = spawnSync(process.execPath, [cli, "check", "--json"], { cwd: p.root, encoding: "utf8" });
    expect(bad.status).toBe(1);
    const report = JSON.parse(bad.stdout) as Report;
    expect(report.findings.map((f) => f.rule)).toEqual(["missing-export"]);
    expect(report.filesChecked).toBe(2);

    fs.writeFileSync(path.join(p.root, "src/a.ts"), GOOD);
    const good = spawnSync(process.execPath, [cli, "check", "--all"], { cwd: p.root, encoding: "utf8" });
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("no problems found");

    const usage = spawnSync(process.execPath, [cli, "check", "--bogus"], { cwd: p.root, encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("unknown option");
  }, 60_000);
});

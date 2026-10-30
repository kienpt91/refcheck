import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli.js";
import { cleanupProjects, createProject, git, initRepo, type TestProject } from "./helpers.js";

const tmpBase = fs.realpathSync(os.tmpdir());
const globalConfig = process.env["GIT_CONFIG_GLOBAL"]!;
const sentinel = path.join(path.dirname(globalConfig), "shared-hooks");

function runCli(args: string[], cwd: string): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: Io = { stdout: (t) => (out += t), stderr: (t) => (err += t), isTTY: false, env: {} };
  return { code: main(args, io, cwd), out, err };
}

function repo(): TestProject {
  const p = createProject();
  initRepo(p.root);
  return p;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function setGlobalHooksPath(dir: string): void {
  execFileSync("git", ["config", "--global", "core.hooksPath", dir], { encoding: "utf8" });
}

beforeAll(() => {
  fs.mkdirSync(sentinel, { recursive: true });
});

afterEach(() => {
  cleanupProjects();
  fs.writeFileSync(globalConfig, "");
});

afterAll(() => {
  // The sentinel stands in for a user's shared hooks directory: nothing may be written to it unless a test allowed it.
  expect(fs.readdirSync(sentinel).filter((f) => !f.endsWith(".allowed"))).toEqual([]);
});

describe("test environment isolation", () => {
  it("uses a temp HOME and temp global git config, never the real ones", () => {
    expect(inside(process.env["HOME"]!, tmpBase)).toBe(true);
    expect(inside(globalConfig, tmpBase)).toBe(true);
    expect(process.env["GIT_CONFIG_NOSYSTEM"]).toBe("1");
    const origin = execFileSync("git", ["config", "--global", "--list", "--show-origin"], { encoding: "utf8" });
    for (const line of origin.split("\n").filter(Boolean)) {
      expect(line.startsWith(`file:${globalConfig}`)).toBe(true);
    }
  });

  it("resolves a global hooksPath inside the temp tree during hook tests", () => {
    setGlobalHooksPath(sentinel);
    const p = repo();
    const resolved = fs.realpathSync(path.resolve(p.root, git(p.root, "rev-parse", "--git-path", "hooks").trim()));
    expect(inside(resolved, tmpBase)).toBe(true);
    expect(inside(resolved, fs.realpathSync(sentinel))).toBe(true);
  });

  it("does not discover a repository above the temp tree", () => {
    const dir = fs.mkdtempSync(path.join(tmpBase, "refcheck-norepo-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      const r = runCli(["hook", "install"], dir);
      expect(r.code).toBe(2);
      expect(r.err).toContain("not inside a git repository");
      expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hook install", () => {
  it("writes an executable pre-commit hook and prints its path", () => {
    const p = repo();
    const r = runCli(["hook", "install"], p.root);
    expect(r.code).toBe(0);
    const hook = path.join(p.root, ".git/hooks/pre-commit");
    expect(r.out).toContain(fs.realpathSync(hook));
    expect(fs.readFileSync(hook, "utf8")).toContain("refcheck check --staged");
    expect(fs.statSync(hook).mode & 0o111).not.toBe(0);
  });

  it("refuses to overwrite an existing hook without --force and leaves it untouched", () => {
    const p = repo();
    const hook = path.join(p.root, ".git/hooks/pre-commit");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\necho mine\n");
    const refused = runCli(["hook", "install"], p.root);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("--force");
    expect(fs.readFileSync(hook, "utf8")).toContain("echo mine");
  });

  it("--force backs up the old hook as pre-commit.bak and reports it", () => {
    const p = repo();
    const hook = path.join(p.root, ".git/hooks/pre-commit");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\necho mine\n");
    const r = runCli(["hook", "install", "--force"], p.root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Replaced");
    expect(r.out).toContain("pre-commit.bak");
    expect(fs.readFileSync(`${hook}.bak`, "utf8")).toContain("echo mine");
    expect(fs.readFileSync(hook, "utf8")).toContain("refcheck");
  });

  it("--force refuses when pre-commit.bak already exists", () => {
    const p = repo();
    const hook = path.join(p.root, ".git/hooks/pre-commit");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "current\n");
    fs.writeFileSync(`${hook}.bak`, "older backup\n");
    const r = runCli(["hook", "install", "--force"], p.root);
    expect(r.code).toBe(2);
    expect(r.err).toContain("pre-commit.bak already exists");
    expect(fs.readFileSync(hook, "utf8")).toBe("current\n");
    expect(fs.readFileSync(`${hook}.bak`, "utf8")).toBe("older backup\n");
  });

  it("fails outside a git repository", () => {
    const dir = fs.mkdtempSync(path.join(tmpBase, "refcheck-norepo-"));
    try {
      expect(runCli(["hook", "install"], dir).code).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hook install: external core.hooksPath", () => {
  it("refuses a global hooksPath outside the repository and names the scope and path", () => {
    setGlobalHooksPath(sentinel);
    const p = repo();
    const r = runCli(["hook", "install"], p.root);
    expect(r.code).toBe(2);
    expect(r.err).toContain(fs.realpathSync(sentinel));
    expect(r.err).toContain("global git config");
    expect(r.err).toContain("--allow-external-hooks-path");
    expect(fs.readdirSync(sentinel)).toEqual([]);
  });

  it("refuses --force alone for an external hooks directory, leaving an existing shared hook intact", () => {
    setGlobalHooksPath(sentinel);
    const shared = path.join(sentinel, "pre-commit");
    fs.writeFileSync(shared, "shared\n");
    try {
      const p = repo();
      expect(runCli(["hook", "install", "--force"], p.root).code).toBe(2);
      expect(fs.readFileSync(shared, "utf8")).toBe("shared\n");
      expect(fs.existsSync(`${shared}.bak`)).toBe(false);
    } finally {
      fs.rmSync(shared);
    }
  });

  it("installs into an external directory only with --allow-external-hooks-path, and says so", () => {
    const external = fs.mkdtempSync(path.join(tmpBase, "refcheck-ext-"));
    try {
      const p = repo();
      git(p.root, "config", "core.hooksPath", external);
      const r = runCli(["hook", "install", "--allow-external-hooks-path"], p.root);
      expect(r.code).toBe(0);
      expect(r.out).toContain(path.join(fs.realpathSync(external), "pre-commit"));
      expect(r.out).toContain("outside the repository");
      expect(r.out).toContain("local git config");
      expect(fs.readFileSync(path.join(external, "pre-commit"), "utf8")).toContain("refcheck");
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it("accepts a relative hooksPath inside the repository without the flag", () => {
    const p = repo();
    git(p.root, "config", "core.hooksPath", ".githooks");
    const r = runCli(["hook", "install"], p.root);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(p.root, ".githooks/pre-commit"))).toBe(true);
  });

  it("rejects a hooksPath that escapes the repository through a symlink", () => {
    const external = fs.mkdtempSync(path.join(tmpBase, "refcheck-ext-"));
    try {
      const p = repo();
      fs.symlinkSync(external, path.join(p.root, "linked-hooks"));
      git(p.root, "config", "core.hooksPath", "linked-hooks");
      const r = runCli(["hook", "install"], p.root);
      expect(r.code).toBe(2);
      expect(fs.readdirSync(external)).toEqual([]);
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });
});

describe("hook install: symlinks", () => {
  it("does not write through a dangling symlink without --force", () => {
    const p = repo();
    const hook = path.join(p.root, ".git/hooks/pre-commit");
    const victim = path.join(p.root, "victim-file");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.symlinkSync(victim, hook);
    const r = runCli(["hook", "install"], p.root);
    expect(r.code).toBe(2);
    expect(r.err).toContain("already exists");
    expect(fs.existsSync(victim)).toBe(false);
    expect(fs.lstatSync(hook).isSymbolicLink()).toBe(true);
  });

  it("replaces a symlink with --force without modifying its target", () => {
    const p = repo();
    const hook = path.join(p.root, ".git/hooks/pre-commit");
    const target = path.join(p.root, "shared-target");
    fs.writeFileSync(target, "original target\n");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.symlinkSync(target, hook);
    const r = runCli(["hook", "install", "--force"], p.root);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(target, "utf8")).toBe("original target\n");
    expect(fs.lstatSync(hook).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(hook, "utf8")).toContain("refcheck");
    expect(fs.lstatSync(`${hook}.bak`).isSymbolicLink()).toBe(true);
  });
});

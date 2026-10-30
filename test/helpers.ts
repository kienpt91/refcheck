import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkFiles } from "../src/checker.js";
import { defaultConfig, type Config } from "../src/config.js";
import { clearPackageCache } from "../src/packages.js";
import type { Finding, Report } from "../src/types.js";

const FIXTURES = path.resolve(import.meta.dirname, "../bench/project");

export interface TestProject {
  root: string;
  write(rel: string, content: string): void;
  /** Writes a fake installed package under node_modules. */
  install(name: string, json: Record<string, unknown>, files?: Record<string, string>): void;
  cleanup(): void;
}

const created: TestProject[] = [];

/**
 * Creates a temp project. With `fixtures` (default) it contains the shared fake
 * packages from bench/project/node_modules and its package.json.
 */
export function createProject(files: Record<string, string> = {}, opts: { fixtures?: boolean } = {}): TestProject {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "refcheck-test-")));
  const project: TestProject = {
    root,
    write(rel, content) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    install(name, json, pkgFiles = {}) {
      const dir = path.join("node_modules", name);
      project.write(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...json }, null, 2));
      for (const [rel, content] of Object.entries(pkgFiles)) project.write(path.join(dir, rel), content);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  if (opts.fixtures ?? true) {
    fs.copyFileSync(path.join(FIXTURES, "package.json"), path.join(root, "package.json"));
    fs.cpSync(path.join(FIXTURES, "node_modules"), path.join(root, "node_modules"), { recursive: true });
  }
  for (const [rel, content] of Object.entries(files)) project.write(rel, content);
  created.push(project);
  return project;
}

export function cleanupProjects(): void {
  for (const p of created.splice(0)) p.cleanup();
  clearPackageCache();
}

export function run(project: TestProject, files: string[], config: Partial<Config> = {}): Report {
  return checkFiles({
    root: project.root,
    files: files.map((f) => path.join(project.root, f)),
    config: { ...defaultConfig(), ...config },
  });
}

/** Checks a single snippet written to src/main.ts and returns findings. */
export function check(source: string, opts: { file?: string; config?: Partial<Config>; files?: Record<string, string> } = {}): Finding[] {
  const file = opts.file ?? "src/main.ts";
  const project = createProject({ [file]: source, ...(opts.files ?? {}) });
  return run(project, [file], opts.config).findings;
}

export function rules(findings: Finding[]): string[] {
  return findings.map((f) => f.rule);
}

export function git(root: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=tester", "-c", "user.email=tester@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Initializes a repository in the temp tree. The sandbox environment keeps git away from real configs. */
export function initRepo(root: string): void {
  git(root, "init", "-q", "-b", "main");
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./types.js";

const SOURCE_RE = /\.[cm]?[jt]sx?$/;
const DECLARATION_RE = /\.d\.[cm]?ts$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out"]);

export function isSourceFile(file: string): boolean {
  return SOURCE_RE.test(file) && !DECLARATION_RE.test(file);
}

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const detail = ((err as { stderr?: string }).stderr ?? "").trim();
    throw new UsageError(
      `git failed (${args[0]}): ${detail || "is this a git repository?"}. Pass explicit paths or use --all.`,
    );
  }
}

function gitTop(root: string): string {
  return fs.realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim());
}

/** Files added, modified, renamed or untracked relative to HEAD (index and working tree). */
export function changedFiles(root: string): string[] {
  const top = gitTop(root);
  const raw = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = raw.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    if (x === "R" || x === "C") i++; // next token is the original path
    if (x === "D" || y === "D") continue;
    files.push(path.join(top, entry.slice(3)));
  }
  return files;
}

/** Files staged for commit (added, copied, modified, renamed). */
export function stagedFiles(root: string): string[] {
  const top = gitTop(root);
  const raw = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]);
  return raw
    .split("\0")
    .filter(Boolean)
    .map((p) => path.join(top, p));
}

export interface CollectOptions {
  root: string;
  cwd: string;
  paths: string[];
  all: boolean;
  staged: boolean;
}

/** Resolves the set of absolute source files to check, sorted and unique. */
export function collectFiles(opts: CollectOptions): string[] {
  let candidates: string[] = [];
  if (opts.paths.length > 0) {
    for (const p of opts.paths) {
      const abs = path.resolve(opts.cwd, p);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw new UsageError(`path not found: ${p}`);
      }
      const real = fs.realpathSync(abs);
      if (stat.isDirectory()) walk(real, candidates);
      else candidates.push(real);
    }
  } else if (opts.all) {
    walk(opts.root, candidates);
  } else if (opts.staged) {
    candidates = stagedFiles(opts.root);
  } else {
    candidates = changedFiles(opts.root);
  }
  const unique = new Set<string>();
  for (const file of candidates) {
    if (!isSourceFile(file)) continue;
    if (!fs.existsSync(file)) continue;
    if (file.split(path.sep).includes("node_modules")) continue;
    if (!file.startsWith(opts.root + path.sep)) continue;
    unique.add(file);
  }
  return [...unique].sort();
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFiles } from "./checker.js";
import { loadConfig } from "./config.js";
import { collectFiles } from "./files.js";
import { installPreCommitHook } from "./hook.js";
import { formatHuman, formatJson } from "./report.js";
import { RULES } from "./rules.js";
import { UsageError } from "./types.js";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether stdout is an interactive terminal. */
  isTTY: boolean;
  env: Record<string, string | undefined>;
}

const HELP = `refcheck - verify code references against what is installed in the project

Usage:
  refcheck check [paths...] [options]   check files (default: files changed vs HEAD)
  refcheck hook install [--force] [--allow-external-hooks-path]
                                        install a git pre-commit hook
  refcheck --help | --version

check options:
  --all             check every source file under the root (skips node_modules, dist, build, dot dirs)
  --staged          check files staged for commit
  --json            print a single JSON object on stdout
  --root <dir>      project root containing package.json (default: current directory)
  --config <file>   config file (default: <root>/refcheck.config.json)
  --no-color        never use colors

Exit codes: 0 no errors (warnings allowed), 1 at least one error, 2 usage or internal error.

Rules: ${RULES.join(", ")}
Suppress a finding with a comment on the previous line: // refcheck-ignore <rule>
`;

function version(): string {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
}

interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(args: string[], valueFlags: string[], boolFlags: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (valueFlags.includes(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || value === "") throw new UsageError(`--${name} requires a value`);
      flags.set(name, value);
    } else if (boolFlags.includes(name) && eq < 0) {
      flags.set(name, true);
    } else {
      throw new UsageError(`unknown option: ${arg}`);
    }
  }
  return { positionals, flags };
}

function resolveRoot(flags: Map<string, string | true>, cwd: string): string {
  const raw = flags.get("root");
  const dir = path.resolve(cwd, typeof raw === "string" ? raw : ".");
  try {
    return fs.realpathSync(dir);
  } catch {
    throw new UsageError(`root directory not found: ${dir}`);
  }
}

function runCheck(args: string[], io: Io, cwd: string): number {
  const { positionals, flags } = parseArgs(args, ["root", "config"], ["json", "all", "staged", "no-color"]);
  const root = resolveRoot(flags, cwd);
  if (flags.has("staged") && (flags.has("all") || positionals.length > 0)) {
    throw new UsageError("--staged cannot be combined with --all or explicit paths");
  }
  const config = loadConfig(root, typeof flags.get("config") === "string" ? (flags.get("config") as string) : undefined);
  const files = collectFiles({
    root,
    cwd,
    paths: positionals,
    all: flags.has("all"),
    staged: flags.has("staged"),
  });
  const report = checkFiles({ root, files, config });
  if (flags.has("json")) {
    io.stdout(formatJson(report));
  } else {
    const color = io.isTTY && !flags.has("no-color") && io.env["NO_COLOR"] === undefined;
    io.stdout(formatHuman(report, color));
  }
  return report.summary.errors > 0 ? 1 : 0;
}

function runHook(args: string[], io: Io, cwd: string): number {
  const [sub, ...rest] = args;
  if (sub !== "install") throw new UsageError(`unknown hook command: ${sub ?? "(none)"} (expected "install")`);
  const { positionals, flags } = parseArgs(rest, ["root"], ["force", "allow-external-hooks-path"]);
  if (positionals.length > 0) throw new UsageError(`unexpected argument: ${positionals[0]}`);
  const result = installPreCommitHook(resolveRoot(flags, cwd), {
    force: flags.has("force"),
    allowExternalHooksPath: flags.has("allow-external-hooks-path"),
  });
  io.stdout(`${result.overwritten ? "Replaced" : "Installed"} pre-commit hook: ${result.path}\n`);
  if (result.backup) io.stdout(`Previous hook saved as: ${result.backup}\n`);
  if (result.external) {
    io.stdout(`Note: this hooks directory is outside the repository${result.hooksPathScope ? ` (core.hooksPath from ${result.hooksPathScope} git config)` : ""} and may apply to other repositories.\n`);
  }
  return 0;
}

/** Runs the CLI and returns the process exit code. */
export function main(argv: string[], io: Io, cwd: string): number {
  try {
    const [command, ...rest] = argv;
    if (command === "--help" || command === "-h" || command === "help") {
      io.stdout(HELP);
      return 0;
    }
    if (command === "--version" || command === "-v") {
      io.stdout(version() + "\n");
      return 0;
    }
    if (command === "check") return runCheck(rest, io, cwd);
    if (command === "hook") return runHook(rest, io, cwd);
    io.stderr(command ? `refcheck: unknown command "${command}"\n\n${HELP}` : HELP);
    return 2;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`refcheck: ${err.message}\n`);
    } else {
      io.stderr(`refcheck: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    }
    return 2;
  }
}

const invokedDirectly = process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const code = main(
    process.argv.slice(2),
    {
      stdout: (t) => void process.stdout.write(t),
      stderr: (t) => void process.stderr.write(t),
      isTTY: Boolean(process.stdout.isTTY),
      env: process.env,
    },
    process.cwd(),
  );
  process.exitCode = code;
}

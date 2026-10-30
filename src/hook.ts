import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./types.js";

export const HOOK_SCRIPT = `#!/bin/sh
# Installed by "refcheck hook install".
# Verifies imports, exports, subpaths and call shapes of staged files against node_modules.
exec npx --no-install refcheck check --staged
`;

export interface HookOptions {
  /** Replace an existing hook (the old one is moved to `pre-commit.bak`). */
  force: boolean;
  /** Allow a hooks directory outside the repository (for example a shared `core.hooksPath`). */
  allowExternalHooksPath: boolean;
}

export interface HookResult {
  path: string;
  overwritten: boolean;
  /** Where the replaced hook was moved, when one existed. */
  backup?: string;
  /** Scope of `core.hooksPath` (`global`, `system`, `local`, ...) when it is set. */
  hooksPathScope?: string;
  /** True when the hooks directory lies outside the repository and the user allowed it. */
  external: boolean;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** realpath of the nearest existing ancestor, with the missing remainder appended. */
function realpathLoose(p: string): string {
  const missing: string[] = [];
  let current = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function hooksPathScope(root: string): string | undefined {
  try {
    const out = git(root, ["config", "--show-scope", "--get", "core.hooksPath"]);
    return out.split(/\s/)[0] || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes the pre-commit hook into the repository's hooks directory (honoring core.hooksPath).
 * Refuses a hooks directory outside the repository unless allowed, never writes through a
 * symlink, and moves a replaced hook to `pre-commit.bak`.
 */
export function installPreCommitHook(root: string, opts: HookOptions): HookResult {
  let hooksDir: string;
  let top: string;
  let commonDir: string;
  try {
    top = realpathLoose(git(root, ["rev-parse", "--show-toplevel"]));
    commonDir = realpathLoose(path.resolve(root, git(root, ["rev-parse", "--git-common-dir"])));
    hooksDir = realpathLoose(path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks"])));
  } catch {
    throw new UsageError(`${root} is not inside a git repository`);
  }
  const scope = hooksPathScope(root);
  const external = !isInside(hooksDir, top) && !isInside(hooksDir, commonDir);
  const target = path.join(hooksDir, "pre-commit");
  if (external && !opts.allowExternalHooksPath) {
    const origin = scope ? ` (core.hooksPath is set in ${scope} git config)` : "";
    throw new UsageError(
      `the hooks directory ${hooksDir} is outside the repository${origin}; it may be shared by other repositories. ` +
        `Refusing to write ${target}. Pass --allow-external-hooks-path to install there anyway.`,
    );
  }

  let backup: string | undefined;
  const present = exists(target);
  if (present) {
    if (!opts.force) {
      throw new UsageError(`${target} already exists; refusing to overwrite it (use --force to replace it)`);
    }
    backup = `${target}.bak`;
    if (exists(backup)) {
      throw new UsageError(`${backup} already exists; move it away before using --force`);
    }
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  if (backup) fs.renameSync(target, backup); // moves a symlink as a symlink; never writes through it
  try {
    fs.writeFileSync(target, HOOK_SCRIPT, { mode: 0o755, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new UsageError(`${target} already exists; refusing to overwrite it (use --force to replace it)`);
    }
    throw err;
  }
  fs.chmodSync(target, 0o755);
  return {
    path: target,
    overwritten: present,
    ...(backup ? { backup } : {}),
    ...(scope ? { hooksPathScope: scope } : {}),
    external,
  };
}

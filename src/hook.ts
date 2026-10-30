import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./types.js";

export const HOOK_SCRIPT = `#!/bin/sh
# Installed by "refcheck hook install".
# Verifies imports, exports, subpaths and call shapes of staged files against node_modules.
exec npx --no-install refcheck check --staged
`;

export interface HookResult {
  path: string;
  overwritten: boolean;
}

/** Writes .git/hooks/pre-commit (honoring core.hooksPath). Refuses to replace an existing hook unless `force`. */
export function installPreCommitHook(root: string, force: boolean): HookResult {
  let hooksDir: string;
  try {
    const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    hooksDir = path.resolve(root, out);
  } catch {
    throw new UsageError(`${root} is not inside a git repository`);
  }
  const target = path.join(hooksDir, "pre-commit");
  const exists = fs.existsSync(target);
  if (exists && !force) {
    throw new UsageError(`${target} already exists; refusing to overwrite it (use --force to replace it)`);
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(target, HOOK_SCRIPT, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  return { path: target, overwritten: exists };
}

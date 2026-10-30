import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Every test file gets a private HOME and private global git config, and git never reads
 * the system config or discovers a repository above the temp tree. Spawned processes and
 * in-process CLI calls inherit this environment, so no test can reach the real user config.
 */
const tmpBase = fs.realpathSync(os.tmpdir());
export const sandbox = fs.mkdtempSync(path.join(tmpBase, "refcheck-sandbox-"));
const home = path.join(sandbox, "home");
fs.mkdirSync(home);
const globalConfig = path.join(sandbox, "gitconfig");
fs.writeFileSync(globalConfig, "");

process.env["HOME"] = home;
process.env["USERPROFILE"] = home;
process.env["XDG_CONFIG_HOME"] = path.join(home, ".config");
process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
process.env["GIT_CEILING_DIRECTORIES"] = tmpBase;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CEILING_DIRECTORIES"].includes(key)) {
    delete process.env[key];
  }
}

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

import fs from "node:fs";
import path from "node:path";
import { MAX_GLOB_LENGTH } from "./glob.js";
import { isRuleId, RULES } from "./rules.js";
import { UsageError } from "./types.js";

export interface Config {
  /** Rules that are never reported. */
  ignoreRules: string[];
  /** Glob patterns (relative to the root) of files that are never checked. */
  ignorePaths: string[];
  /** Package names whose findings are dropped. */
  ignorePackages: string[];
  /** Per-rule severity override. */
  severity: Record<string, "error" | "warning" | "off">;
}

export const CONFIG_FILE = "refcheck.config.json";

export function defaultConfig(): Config {
  return { ignoreRules: [], ignorePaths: [], ignorePackages: [], severity: {} };
}

function stringArray(value: unknown, key: string, file: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new UsageError(`${file}: "${key}" must be an array of strings`);
  }
  if (key === "ignorePaths" && (value as string[]).some((v) => v.length > MAX_GLOB_LENGTH)) {
    throw new UsageError(`${file}: "ignorePaths" patterns must be at most ${MAX_GLOB_LENGTH} characters`);
  }
  return value as string[];
}

function ruleArray(value: unknown, key: string, file: string): string[] {
  const rules = stringArray(value, key, file);
  for (const r of rules) {
    if (!isRuleId(r)) throw new UsageError(`${file}: unknown rule "${r}" in "${key}" (known: ${RULES.join(", ")})`);
  }
  return rules;
}

export function parseConfig(raw: unknown, file = CONFIG_FILE): Config {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new UsageError(`${file}: expected a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const known = new Set(["ignoreRules", "ignorePaths", "ignorePackages", "severity"]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) throw new UsageError(`${file}: unknown key "${key}"`);
  }
  const severity: Config["severity"] = {};
  if (obj.severity !== undefined) {
    if (obj.severity === null || typeof obj.severity !== "object" || Array.isArray(obj.severity)) {
      throw new UsageError(`${file}: "severity" must be an object`);
    }
    for (const [rule, level] of Object.entries(obj.severity as Record<string, unknown>)) {
      if (!isRuleId(rule)) throw new UsageError(`${file}: unknown rule "${rule}" in "severity" (known: ${RULES.join(", ")})`);
      if (level !== "error" && level !== "warning" && level !== "off") {
        throw new UsageError(`${file}: severity for "${rule}" must be "error", "warning" or "off"`);
      }
      severity[rule] = level;
    }
  }
  return {
    ignoreRules: ruleArray(obj.ignoreRules, "ignoreRules", file),
    ignorePaths: stringArray(obj.ignorePaths, "ignorePaths", file),
    ignorePackages: stringArray(obj.ignorePackages, "ignorePackages", file),
    severity,
  };
}

/** Loads `refcheck.config.json` from the root (or an explicit file). Missing default file means defaults. */
export function loadConfig(root: string, explicit?: string): Config {
  const file = explicit ? path.resolve(explicit) : path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    if (explicit) throw new UsageError(`config file not found: ${explicit}`);
    return defaultConfig();
  }
  let raw: unknown;
  try {
    if (fs.statSync(file).size > 1024 * 1024) throw new Error("file is larger than 1 MiB");
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new UsageError(`${path.basename(file)}: invalid JSON (${(err as Error).message})`);
  }
  return parseConfig(raw, path.basename(file));
}

import fs from "node:fs";
import path from "node:path";
import { isWithin } from "./packages.js";

/** How the importing syntax selects conditions. `types` accepts both `import` and `require`. */
export type ImportKind = "import" | "require" | "types";

export interface ExportOutcome {
  ok: boolean;
  reason?: "not-exported" | "blocked" | "no-condition" | "file-missing";
  /** Exported subpath keys without wildcards, for suggestions. */
  keys: string[];
}

type Walk = "ok" | "blocked" | "no-condition" | "file-missing";

function normalize(field: unknown): Record<string, unknown> {
  if (typeof field === "string" || Array.isArray(field)) return { ".": field };
  if (field !== null && typeof field === "object") {
    const keys = Object.keys(field);
    if (keys.length > 0 && keys.every((k) => k.startsWith("."))) return field as Record<string, unknown>;
    if (keys.some((k) => k.startsWith("."))) return {};
    return { ".": field };
  }
  return {};
}

const TYPE_VARIANTS: Record<string, string[]> = {
  ".js": [".d.ts", ".ts", ".tsx"],
  ".mjs": [".d.mts", ".mts"],
  ".cjs": [".d.cts", ".cts"],
  ".jsx": [".d.ts", ".tsx"],
};

function targetExists(pkgDir: string, target: string): boolean {
  const abs = path.resolve(pkgDir, target);
  if (!isWithin(pkgDir, abs)) return false;
  if (fs.existsSync(abs)) return true;
  const ext = path.extname(abs);
  const stem = abs.slice(0, abs.length - ext.length);
  for (const variant of TYPE_VARIANTS[ext] ?? []) if (fs.existsSync(stem + variant)) return true;
  return fs.existsSync(abs + ".d.ts");
}

const MAX_DEPTH = 32;

function walk(target: unknown, kind: ImportKind, match: string | undefined, pkgDir: string, depth = 0): Walk {
  if (depth > MAX_DEPTH) return "no-condition";
  if (typeof target === "string") {
    if (match === undefined) return "ok";
    return targetExists(pkgDir, target.replaceAll("*", match)) ? "ok" : "file-missing";
  }
  if (target === null) return "blocked";
  if (Array.isArray(target)) {
    let last: Walk = "no-condition";
    for (const item of target) {
      const r = walk(item, kind, match, pkgDir, depth + 1);
      if (r === "ok") return "ok";
      last = r;
    }
    return last;
  }
  if (typeof target === "object") {
    let result: Walk = "no-condition";
    for (const [condition, value] of Object.entries(target as Record<string, unknown>)) {
      if (condition === "import" && kind === "require") continue;
      if (condition === "require" && kind === "import") continue;
      const r = walk(value, kind, match, pkgDir, depth + 1);
      if (r === "ok") return "ok";
      if (r === "blocked") return "blocked";
      if (r === "file-missing") result = "file-missing";
    }
    return result;
  }
  return "no-condition";
}

/**
 * Resolves `subpath` ("." or "./x") against a package.json `exports` field.
 * Only `import` and `require` are treated as selective conditions; every other
 * condition (types, default, node, browser, worker, ...) is considered matchable
 * so that unusual runtimes do not produce false positives.
 */
export function resolveExports(field: unknown, subpath: string, kind: ImportKind, pkgDir: string): ExportOutcome {
  const map = normalize(field);
  const keys = Object.keys(map).filter((k) => !k.includes("*"));
  const finish = (r: Walk): ExportOutcome => {
    if (r === "ok") return { ok: true, keys };
    return { ok: false, reason: r === "blocked" ? "blocked" : r, keys };
  };
  if (Object.hasOwn(map, subpath) && !subpath.includes("*")) {
    return finish(walk(map[subpath], kind, undefined, pkgDir));
  }
  let bestKey: string | undefined;
  let bestMatch = "";
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length >= key.length && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      if (bestKey === undefined || prefix.length > bestKey.indexOf("*")) {
        bestKey = key;
        bestMatch = subpath.slice(prefix.length, subpath.length - suffix.length);
      }
    }
  }
  if (bestKey === undefined) return { ok: false, reason: "not-exported", keys };
  return finish(walk(map[bestKey], kind, bestMatch, pkgDir));
}

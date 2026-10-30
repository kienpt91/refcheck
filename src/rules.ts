import type { Severity } from "./types.js";

export const RULES = [
  "unknown-package",
  "not-installed",
  "unresolved-subpath",
  "missing-export",
  "bad-call-arity",
  "unknown-option-key",
  "deprecated-api",
  "relative-import-missing",
] as const;

export type RuleId = (typeof RULES)[number];

export const DEFAULT_SEVERITY: Record<RuleId, Severity> = {
  "unknown-package": "error",
  "not-installed": "warning",
  "unresolved-subpath": "error",
  "missing-export": "error",
  "bad-call-arity": "error",
  "unknown-option-key": "error",
  "deprecated-api": "warning",
  "relative-import-missing": "error",
};

export function isRuleId(value: string): value is RuleId {
  return (RULES as readonly string[]).includes(value);
}

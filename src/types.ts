export type Severity = "error" | "warning";

export interface Finding {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  column: number;
  message: string;
  package?: string;
  symbol?: string;
  suggestion?: string;
}

export interface Report {
  version: 1;
  root: string;
  filesChecked: number;
  findings: Finding[];
  summary: { errors: number; warnings: number };
}

/** Thrown for bad CLI usage, bad config, or an unusable project. Maps to exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

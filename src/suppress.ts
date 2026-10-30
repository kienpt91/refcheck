const DIRECTIVE = /refcheck-ignore\b([^\n]*)/;

/** Rules suppressed per 1-based line; `"all"` suppresses every rule. */
export type Suppressions = Map<number, Set<string> | "all">;

function parseRules(tail: string): Set<string> | "all" {
  const cut = tail.split("--")[0]!.replace(/\*\/.*$/, "").replace(/[}]/g, "");
  const tokens = cut.split(/[\s,]+/).filter((t) => /^[a-z][a-z0-9-]*$/.test(t));
  return tokens.length === 0 ? "all" : new Set(tokens);
}

function add(map: Suppressions, line: number, rules: Set<string> | "all"): void {
  const existing = map.get(line);
  if (existing === "all" || rules === "all") {
    map.set(line, "all");
  } else if (existing) {
    for (const r of rules) existing.add(r);
  } else {
    map.set(line, new Set(rules));
  }
}

/**
 * Finds `refcheck-ignore [rule...]` directives in comments. A directive on a
 * comment-only line applies to the next line; a trailing comment applies to its own line.
 */
export function parseSuppressions(text: string): Suppressions {
  const map: Suppressions = new Map();
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const m = DIRECTIVE.exec(line);
    if (!m) return;
    const commentStart = Math.min(...["//", "/*"].map((t) => (line.indexOf(t) >= 0 ? line.indexOf(t) : Infinity)));
    if (!Number.isFinite(commentStart) || commentStart > m.index) return;
    const rules = parseRules(m[1] ?? "");
    const commentOnly = line.slice(0, commentStart).replace(/[{\s]/g, "") === "";
    add(map, commentOnly ? index + 2 : index + 1, rules);
  });
  return map;
}

export function isSuppressed(map: Suppressions, lines: number[], rule: string): boolean {
  return lines.some((line) => {
    const entry = map.get(line);
    return entry === "all" || (entry !== undefined && entry.has(rule));
  });
}

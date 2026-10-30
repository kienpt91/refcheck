import type { Finding, Report } from "./types.js";

export function formatJson(report: Report): string {
  return JSON.stringify(report, null, 2) + "\n";
}

function paint(enabled: boolean, code: string, text: string): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Findings grouped by file, one line each; colors only when `color` is true. */
export function formatHuman(report: Report, color: boolean): string {
  const lines: string[] = [];
  const byFile = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  for (const [file, findings] of byFile) {
    lines.push(paint(color, "4", file));
    const widest = Math.max(...findings.map((f) => `${f.line}:${f.column}`.length));
    for (const f of findings) {
      const loc = `${f.line}:${f.column}`.padEnd(widest);
      const sev = f.severity === "error" ? paint(color, "31", "error  ") : paint(color, "33", "warning");
      lines.push(`  ${paint(color, "2", loc)}  ${sev}  ${f.message}  ${paint(color, "2", f.rule)}`);
      if (f.suggestion) lines.push(`  ${" ".repeat(widest)}           ${paint(color, "36", `did you mean "${f.suggestion}"?`)}`);
    }
    lines.push("");
  }
  const { errors, warnings } = report.summary;
  const checked = plural(report.filesChecked, "file");
  if (errors + warnings === 0) {
    lines.push(`refcheck: ${checked} checked, no problems found`);
  } else {
    lines.push(`refcheck: ${checked} checked, ${plural(errors, "error")}, ${plural(warnings, "warning")}`);
  }
  return lines.join("\n") + "\n";
}

// Runs refcheck over the labelled snippets in bench/project/cases and prints precision/recall per rule.
// Every snippet starts with `// expect: <rule>` or `// expect: none`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFiles, defaultConfig, RULES } from "../dist/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(path.join(here, "project"));
const casesDir = path.join(root, "cases");
const files = fs
  .readdirSync(casesDir)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .map((f) => path.join(casesDir, f));

const expected = new Map();
for (const file of files) {
  const match = /^\/\/ expect: (\S+)/.exec(fs.readFileSync(file, "utf8"));
  if (!match) throw new Error(`${file}: missing "// expect:" header`);
  expected.set(path.relative(root, file).split(path.sep).join("/"), match[1]);
}

const started = process.hrtime.bigint();
const report = checkFiles({ root, files, config: defaultConfig() });
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

const fired = new Map([...expected.keys()].map((f) => [f, new Set()]));
for (const finding of report.findings) fired.get(finding.file)?.add(finding.rule);

const stats = Object.fromEntries(RULES.map((r) => [r, { tp: 0, fp: 0, fn: 0 }]));
const mismatches = [];
let unexpected = 0;
for (const [file, expectation] of expected) {
  const got = fired.get(file);
  for (const rule of RULES) {
    const want = expectation === rule;
    const have = got.has(rule);
    if (want && have) stats[rule].tp++;
    else if (!want && have) stats[rule].fp++;
    else if (want && !have) stats[rule].fn++;
  }
  const ok = expectation === "none" ? got.size === 0 : got.size === 1 && got.has(expectation);
  if (!ok) {
    mismatches.push(`${file}: expected ${expectation}, got ${got.size ? [...got].join(", ") : "nothing"}`);
    if ([...got].some((rule) => rule !== expectation)) unexpected++;
  }
}

const pct = (n, d) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`);
const rows = RULES.map((rule) => {
  const { tp, fp, fn } = stats[rule];
  return [rule, String(tp + fn), String(tp), String(fp), String(fn), pct(tp, tp + fp), pct(tp, tp + fn)];
});
const header = ["rule", "cases", "TP", "FP", "FN", "precision", "recall"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
console.log(line(header));
for (const row of rows) console.log(line(row));

const total = expected.size;
const clean = [...expected.values()].filter((e) => e === "none").length;
const correct = total - mismatches.length;
console.log("");
console.log(`snippets: ${total} (${clean} correct, ${total - clean} with a hallucinated reference)`);
console.log(`snippets classified exactly right: ${correct}/${total}`);
console.log(`analysis time: ${elapsedMs.toFixed(0)} ms for ${total} files in one program`);
if (mismatches.length > 0) {
  console.log("\nmismatches (misses are expected for the miss-* snippets):");
  for (const m of mismatches) console.log(`  ${m}`);
}
if (unexpected > 0) {
  console.log(`\n${unexpected} snippet(s) produced a finding that was not expected (false positive)`);
  process.exitCode = 1;
}

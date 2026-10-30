import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/checker.js";
import { defaultConfig } from "../src/config.js";

const root = fs.realpathSync(path.resolve(import.meta.dirname, "../bench/project"));
const casesDir = path.join(root, "cases");
const files = fs
  .readdirSync(casesDir)
  .filter((f) => f.endsWith(".ts"))
  .sort();

describe("bench snippets", () => {
  const report = checkFiles({ root, files: files.map((f) => path.join(casesDir, f)), config: defaultConfig() });
  const rulesByFile = new Map<string, string[]>();
  for (const f of report.findings) rulesByFile.set(f.file, [...(rulesByFile.get(f.file) ?? []), f.rule]);

  for (const file of files) {
    const header = /^\/\/ expect: (\S+)/.exec(fs.readFileSync(path.join(casesDir, file), "utf8"));
    const expected = header![1]!;
    const got = rulesByFile.get(`cases/${file}`) ?? [];
    if (file.startsWith("miss-")) {
      it(`${file}: known miss is still not reported`, () => {
        expect(got).toEqual([]);
      });
    } else {
      it(`${file}: ${expected}`, () => {
        expect([...new Set(got)]).toEqual(expected === "none" ? [] : [expected]);
      });
    }
  }
});

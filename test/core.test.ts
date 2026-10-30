import { describe, expect, it } from "vitest";
import { closest, distance } from "../src/fuzzy.js";
import { globToRegExp } from "../src/glob.js";
import { parseConfig } from "../src/config.js";
import { UsageError } from "../src/types.js";

describe("fuzzy matching", () => {
  it("counts a transposition as one edit", () => {
    expect(distance("htpp", "http")).toBe(1);
  });

  it("suggests close names and ignores unrelated ones", () => {
    expect(closest("tiny-htpp", ["left-pad", "tiny-http"])).toBe("tiny-http");
    expect(closest("timeOut", ["timeout", "retries"])).toBe("timeout");
    expect(closest("postJson", ["get", "post"])).toBe("post");
    expect(closest("left-pad-pro", ["tiny-http", "csv-lite"])).toBeUndefined();
  });
});

describe("glob", () => {
  it("matches basenames at any depth when there is no slash", () => {
    const re = globToRegExp("*.generated.ts");
    expect(re.test("a.generated.ts")).toBe(true);
    expect(re.test("src/deep/a.generated.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(false);
  });

  it("supports ** and directory prefixes", () => {
    expect(globToRegExp("src/**/gen/*.ts").test("src/a/b/gen/x.ts")).toBe(true);
    expect(globToRegExp("src/**/gen/*.ts").test("src/gen/x.ts")).toBe(true);
    expect(globToRegExp("vendor/").test("vendor/a/b.ts")).toBe(true);
    expect(globToRegExp("vendor/").test("src/vendor.ts")).toBe(false);
  });
});

describe("config parsing", () => {
  it("accepts a full config", () => {
    const cfg = parseConfig({
      ignoreRules: ["deprecated-api"],
      ignorePaths: ["dist/**"],
      ignorePackages: ["virtual-pkg"],
      severity: { "unknown-option-key": "warning", "not-installed": "off" },
    });
    expect(cfg.severity["not-installed"]).toBe("off");
    expect(cfg.ignoreRules).toEqual(["deprecated-api"]);
  });

  it("rejects unknown rules, keys and severities", () => {
    expect(() => parseConfig({ ignoreRules: ["nope"] })).toThrow(UsageError);
    expect(() => parseConfig({ bogus: 1 })).toThrow(/unknown key/);
    expect(() => parseConfig({ severity: { "missing-export": "fatal" } })).toThrow(/must be/);
    expect(() => parseConfig([])).toThrow(UsageError);
  });
});

describe("hardening", () => {
  it("collapses star runs so hostile patterns stay fast", () => {
    const re = globToRegExp("**/**/**/**/**/**/x");
    const start = Date.now();
    expect(re.test("a/".repeat(5000) + "y")).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(globToRegExp("a**b").test("axxb")).toBe(true);
  });

  it("rejects very long ignorePaths patterns", () => {
    expect(() => parseConfig({ ignorePaths: ["*".repeat(300)] })).toThrow(/at most/);
  });
});

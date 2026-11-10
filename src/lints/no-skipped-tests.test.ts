import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findSkippedTests } from "./no-skipped-tests.ts";

const lines = (source: string, file = "src/app.test.ts") => findSkippedTests(file, source).map(finding => finding.line);
// Built from pieces so this file doesn't trip the lint it tests.
const dot = (root: string, modifier: string) => `${root}.${modifier}`;

describe("no skipped or focused tests", () => {
  it("finds skipped, focused and parked tests in the common runners' spellings", () => {
    const source = [
      `${dot("it", "skip")}("waits", () => {});`,
      `${dot("describe", "only")}("focus", () => {});`,
      `${dot("test", "todo")}("later");`,
      `x${"it"}("old style", () => {});`,
      `test("node options", { ${"skip"}: true }, () => {});`,
      `test("inside", t => { t.${"skip"}("not now"); });`,
      `it("fine", () => {});`,
    ].join("\n");
    assert.deepEqual(lines(source), [1, 2, 3, 4, 5, 6]);
  });

  it("ignores comment lines, other files, and names that only look alike", () => {
    assert.deepEqual(lines(`// ${dot("it", "skip")}("explained in a comment")`), []);
    assert.deepEqual(lines(`${dot("it", "skip")}("not a test file")`, "src/app.ts"), []);
    assert.deepEqual(lines("const exit = () => {}; exit(); profit(1); obj.skipped = true;"), []);
  });
});

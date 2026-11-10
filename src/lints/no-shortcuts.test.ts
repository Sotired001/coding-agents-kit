import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findShortcuts } from "./no-shortcuts.ts";

const kinds = (file: string, source: string) => findShortcuts(file, source).map(finding => `${finding.line}:${finding.kind}`);
// Built from pieces so this file doesn't trip the lint it tests.
const ignore = "// @ts-" + "ignore";
const disable = "/* eslint-" + "disable */";

describe("no shortcuts past the type checker", () => {
  it("finds any, non-null and definite assignment assertions, and casts through unknown", () => {
    const source = [
      "let a: any = 1;",
      "const b = c!.d;",
      "let e!: string;",
      "class F { g!: number; h?: string; }",
      "const i = j as unknown as K;",
      "const l = (m as unknown) as N;",
      "function o(p: Record<string, any>): void {}",
    ].join("\n");
    assert.deepEqual(kinds("src/app.ts", source), [
      "1:any", "2:non-null !", "3:definite assignment !", "4:definite assignment !",
      "5:cast through unknown", "6:cast through unknown", "7:any",
    ]);
  });

  it("leaves code alone: not-operators, strings, comments, single casts, and the word any as a value", () => {
    const source = [
      "if (!ready) start();",
      "const s = 'x! as unknown as any';",
      "// any x! here is only a comment",
      "const t = value as Thing;",
      "const any = 1; const u = `${any}`;",
      "const v = a !== b;",
      "type Name = \"any\";",
    ].join("\n");
    assert.deepEqual(kinds("src/app.ts", source), []);
  });

  it("allows a cast through unknown with a reason on the line above", () => {
    const source = ["// unchecked: the platform types this as a plain object", "const w = x as unknown as Y;"].join("\n");
    assert.deepEqual(kinds("src/app.ts", source), []);
  });

  it("refuses suppression comments everywhere, tests included, but lets tests use any and !", () => {
    assert.deepEqual(kinds("src/app.test.ts", `${ignore}\nconst a: any = b!;\n${disable}`), ["1:@ts-ignore", "3:eslint-disable"]);
  });

  it("reports a file Node's stripper can't read as unchecked instead of passing it", () => {
    const [finding] = findShortcuts("src/colors.ts", "enum Color { Red }");
    assert.match(finding?.kind ?? "", /^unchecked file/);
  });
});

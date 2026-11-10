// No skipped, focused or parked tests. An agent that can't make a test pass will often mark it `.skip` or `.todo`,
// and one debugging a single test leaves `.only` behind, which silently turns the rest of the file off.
//   node src/lints/no-skipped-tests.ts [directory]   every tracked *.test.* / *.spec.* file in that repository
// Pattern based (one line at a time, comment lines left out), covering the common runners: describe/it/test/suite/
// context/specify with .only/.skip/.todo/.fixme/.fail/.fails, xit/xdescribe/xtest/fit/fdescribe, node:test's
// { skip: ... } / { only: ... } / { todo: ... } options, and t.skip() / t.todo() inside a test. It reads no syntax tree,
// so a match inside a string literal is reported too; reword the string.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type SkippedTestFinding = { file: string; line: number; text: string };

const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:cjs|js|jsx|mjs|ts|tsx|mts|cts)$/u;
const PATTERNS: readonly RegExp[] = [
  /\b(?:describe|it|test|suite|context|specify)\s*\.\s*(?:only|skip|todo|fixme|fail|fails)\b/u,
  /(?:^|[^.\w$])(?:xdescribe|xit|xtest|fdescribe|fit)\s*\(/u,
  /\b(?:describe|it|test|suite)\s*\([^)]*\{\s*(?:skip|only|todo)\s*:/u,
  /\bt\s*\.\s*(?:skip|todo)\s*\(/u,
];

export function findSkippedTests(file: string, source: string): SkippedTestFinding[] {
  if (!TEST_FILE.test(file)) return [];
  return source.split("\n").flatMap((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return [];
    return PATTERNS.some(pattern => pattern.test(text)) ? [{ file, line: index + 1, text: trimmed.slice(0, 120) }] : [];
  });
}

export function findAllSkippedTests(cwd: string): SkippedTestFinding[] {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" }).split("\0")
    .filter(file => TEST_FILE.test(file) && !file.startsWith("node_modules/"));
  return files.flatMap(file => findSkippedTests(file, readFileSync(resolve(cwd, file), "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.argv[2] ?? process.cwd(), encoding: "utf8" }).trim();
  const found = findAllSkippedTests(cwd);
  for (const finding of found) console.error(`${finding.file}:${finding.line} ${finding.text}`);
  if (found.length) {
    console.error(`\n${found.length} skipped or focused tests. Make the test pass, or delete it if it no longer holds.`);
    process.exitCode = 1;
  }
}

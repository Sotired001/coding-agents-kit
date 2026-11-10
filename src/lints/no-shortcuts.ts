// No shortcuts past the type checker. Code that can't go on without a value says so and throws; it never tells the
// compiler "trust me". Agents reach for these when a type error is in the way, so the gate refuses them.
//   node src/lints/no-shortcuts.ts [directory]    every tracked .ts/.mts/.cts file in the directory's repository
//
// Everywhere: `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` and `eslint-disable` comments.
// Outside tests also: `any`, a non-null `!` (`x!`), a definite assignment `!` (`let x!: T`, `field!: T`), and a cast
// through unknown (`x as unknown as T`), which turns the checker off. Such a cast is allowed only with a reason on the
// line above it: `// unchecked: <why the types can't say it>`. A single `x as T` is allowed.
//
// How it reads TypeScript without the compiler: Node's built-in type stripper (node:module stripTypeScriptTypes)
// replaces every piece of type syntax with spaces and keeps every position. A character that is code in the source and
// a space in the stripped text was type syntax, so `any` there is the type `any`, and a `!` there is an assertion.
// Limits: Node's stripper does not take .tsx, enums, namespaces, parameter properties or `<T>x` assertions; a file
// using them is reported as unchecked (a finding), and .tsx files are not read at all. See README.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ShortcutFinding = { file: string; line: number; column: number; kind: string; text: string };

const SOURCE = /\.(?:ts|mts|cts)$/u;
const SKIPPED = /\.d\.[cm]?ts$/u;
const TEST = /(?:^|\/)tests?\/|\.(?:test|spec)\.[cm]?ts$/u;
const DIRECTIVES = /(?:\/\/|\/\*)\s*(@ts-(?:ignore|expect-error|nocheck)\b|eslint-disable)/gu;
const UNCHECKED = /\/\/ unchecked: \S/u;

function position(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  return { line, column: index - before.lastIndexOf("\n") };
}

/** The shortcuts in one file. */
export function findShortcuts(file: string, source: string): ShortcutFinding[] {
  const found: ShortcutFinding[] = [];
  const at = (index: number, kind: string) => {
    const { line, column } = position(source, index);
    const text = (source.split("\n")[line - 1] ?? "").trim().slice(0, 120);
    found.push({ file, line, column, kind, text });
  };
  for (const match of source.matchAll(DIRECTIVES)) at(match.index, match[1] ?? "directive");
  if (TEST.test(file)) return found;
  let stripped: string;
  try {
    stripped = stripTypeScriptTypes(source, { mode: "strip" });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    at(0, `unchecked file (Node can't strip it: ${reason})`);
    return found;
  }
  if (stripped.length !== source.length) throw new Error(`${file}: the stripped text changed length; positions can't be compared`);
  const isType = (index: number) => /\S/u.test(source[index] ?? "") && stripped[index] === " ";
  const lines = source.split("\n");
  for (const match of source.matchAll(/\bany\b/gu)) {
    const quoted = /["'`]/u.test(source[match.index - 1] ?? "") && /["'`]/u.test(source[match.index + 3] ?? "");
    if (isType(match.index) && !quoted) at(match.index, "any");
  }
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== "!" || !isType(index)) continue;
    const after = source.slice(index + 1).match(/^\s*(\S)/u)?.[1];
    at(index, after === ":" ? "definite assignment !" : "non-null !");
  }
  for (const match of source.matchAll(/\bas\s+unknown\b/gu)) {
    if (!isType(match.index)) continue;
    const end = match.index + match[0].length;
    const next = /^[\s)]*\bas\b/u.exec(source.slice(end));
    if (!next || !isType(end + next[0].length - 2)) continue;
    const line = position(source, match.index).line;
    if (!UNCHECKED.test(lines[line - 2] ?? "")) at(match.index, "cast through unknown");
  }
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Every tracked TypeScript file's shortcuts. */
export function findAllShortcuts(cwd: string): ShortcutFinding[] {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" }).split("\0")
    .filter(file => SOURCE.test(file) && !SKIPPED.test(file) && !file.startsWith("node_modules/"));
  return files.flatMap(file => findShortcuts(file, readFileSync(resolve(cwd, file), "utf8")));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.argv[2] ?? process.cwd(), encoding: "utf8" }).trim();
  const found = findAllShortcuts(cwd);
  for (const finding of found) console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.kind}: ${finding.text}`);
  if (found.length) {
    console.error(`\n${found.length} shortcuts past the type checker. Handle the value (a check that throws, or a parse) instead.`);
    process.exitCode = 1;
  }
}

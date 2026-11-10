// Small state files each checkout keeps inside its own Git directory (so they never show up as changes):
// the receipt of its last check gate run, and the task it was made for.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

/** The main checkout of the repository `cwd` is in, even when `cwd` is a linked worktree. */
export function mainCheckout(cwd: string): string {
  return dirname(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

export function statePath(root: string, name: string): string {
  return join(git(root, ["rev-parse", "--absolute-git-dir"]), `agents-kit-${name}.json`);
}

/** Evidence only, never a cache that skips checks. Covers HEAD, uncommitted edits and untracked files. */
export function sourceFingerprint(root: string): string {
  const hash = createHash("sha256");
  hash.update(git(root, ["rev-parse", "HEAD"]));
  hash.update(execFileSync("git", ["diff", "HEAD", "--binary", "--no-ext-diff"], { cwd: root, maxBuffer: 32 * 1024 * 1024 }));
  const paths = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  for (const path of paths.split("\0").filter(Boolean).sort()) {
    const absolute = join(root, path);
    hash.update(path).update("\0");
    hash.update(lstatSync(absolute).isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export type Stage = { label: string; status: number; durationMs: number };
export type CheckReceipt = {
  head: string; fingerprint: string; base: string; startedAt: string; finishedAt: string;
  status: number; durationMs: number; sourceChanged: boolean; stages: Stage[];
};

function field<T>(value: Record<string, unknown>, name: string, check: (item: unknown) => item is T, what: string): T {
  const item = value[name];
  if (!check(item)) throw new Error(`check receipt: ${name} must be ${what}`);
  return item;
}
const isString = (item: unknown): item is string => typeof item === "string";
const isNumber = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item);
const isBoolean = (item: unknown): item is boolean => typeof item === "boolean";
const isObject = (item: unknown): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item);

/** Checks a receipt read from disk. A missing or wrong field is an error, never a pass. */
export function parseReceipt(raw: unknown): CheckReceipt {
  if (!isObject(raw)) throw new Error("check receipt must be an object");
  const stages = raw.stages;
  if (!Array.isArray(stages)) throw new Error("check receipt: stages must be a list");
  return {
    head: field(raw, "head", isString, "a string"),
    fingerprint: field(raw, "fingerprint", isString, "a string"),
    base: field(raw, "base", isString, "a string"),
    startedAt: field(raw, "startedAt", isString, "a string"),
    finishedAt: field(raw, "finishedAt", isString, "a string"),
    status: field(raw, "status", isNumber, "a number"),
    durationMs: field(raw, "durationMs", isNumber, "a number"),
    sourceChanged: field(raw, "sourceChanged", isBoolean, "true or false"),
    stages: stages.map((stage: unknown) => {
      if (!isObject(stage)) throw new Error("check receipt: each stage must be an object");
      return { label: field(stage, "label", isString, "a string"), status: field(stage, "status", isNumber, "a number"),
        durationMs: field(stage, "durationMs", isNumber, "a number") };
    }),
  };
}

export function writeState(root: string, name: string, value: object): void {
  const path = statePath(root, name);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function readCheckReceipt(root: string): CheckReceipt | null {
  const path = statePath(root, "checks");
  return existsSync(path) ? parseReceipt(JSON.parse(readFileSync(path, "utf8"))) : null;
}

export function readTask(root: string): string | null {
  const path = statePath(root, "task");
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isObject(raw) || typeof raw.task !== "string" || !raw.task) throw new Error(`${path} must hold {"task": "<id>"}`);
  return raw.task;
}

/** "passed", "FAILED", "stale" (the source or the base moved since), or "not run". */
export function receiptStatus(root: string, base: string): string {
  const receipt = readCheckReceipt(root);
  if (!receipt) return "not run";
  const currentBase = git(root, ["merge-base", "HEAD", base]);
  // Once a checked branch merges, its base moves forward to HEAD. The gate covered that larger change set,
  // so merging alone must not make the receipt look stale.
  const current = receipt.fingerprint === sourceFingerprint(root)
    && receipt.base === git(root, ["merge-base", receipt.base, currentBase]);
  if (!current || receipt.sourceChanged) return "stale";
  return receipt.status === 0 ? "passed" : "FAILED";
}

export function worktreePaths(root: string): string[] {
  return execFileSync("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
}

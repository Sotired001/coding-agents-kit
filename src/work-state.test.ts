import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { cleanUp, repository, run, temporaryDirectory } from "./testing.ts";
import { readCheckReceipt, readTask, receiptStatus, sourceFingerprint, worktreePaths, writeState } from "./work-state.ts";

afterEach(cleanUp);

function receipt(root: string, extra: Record<string, unknown> = {}) {
  return { head: run(root, ["rev-parse", "HEAD"]), fingerprint: sourceFingerprint(root), base: run(root, ["rev-parse", "origin/main"]),
    startedAt: "2026-01-01", finishedAt: "2026-01-01", status: 0, durationMs: 42, sourceChanged: false, stages: [], ...extra };
}

describe("check evidence", () => {
  it("keeps an unchanged branch's receipt valid after that branch merges", () => {
    const { main } = repository();
    const base = run(main, ["rev-parse", "HEAD"]);
    run(main, ["commit", "--allow-empty", "-qm", "feature"]);
    writeState(main, "checks", receipt(main, { base }));
    assert.equal(receiptStatus(main, "origin/main"), "passed");
    run(main, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    assert.equal(receiptStatus(main, "origin/main"), "passed");
  });

  it("goes stale on tracked edits, untracked files and a moved base", () => {
    const { main } = repository();
    const written = receipt(main);
    writeState(main, "checks", written);
    assert.deepEqual(readCheckReceipt(main), written);
    assert.equal(receiptStatus(main, "origin/main"), "passed");
    writeFileSync(join(main, "README.md"), "edited\n");
    assert.equal(receiptStatus(main, "origin/main"), "stale");
    run(main, ["restore", "README.md"]);
    writeFileSync(join(main, "new.ts"), "export const added = true;\n");
    assert.equal(receiptStatus(main, "origin/main"), "stale");
    rmSync(join(main, "new.ts"));
    assert.equal(receiptStatus(main, "origin/main"), "passed");
    run(main, ["commit", "--allow-empty", "-qm", "new base"]);
    run(main, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    assert.equal(receiptStatus(main, "origin/main"), "stale");
  });

  it("never treats missing or corrupt evidence as success, and handles paths with spaces", () => {
    const { main } = repository();
    assert.equal(receiptStatus(main, "origin/main"), "not run");
    writeState(main, "checks", { status: 0 });
    assert.throws(() => readCheckReceipt(main), /check receipt/);
    const path = join(temporaryDirectory("spaces"), "a linked tree");
    run(main, ["worktree", "add", "-qb", "feature", path]);
    assert.deepEqual(worktreePaths(main), [main, path]);
  });

  it("reads the task a worktree was made for, and refuses a malformed task file", () => {
    const { main } = repository();
    assert.equal(readTask(main), null);
    writeState(main, "task", { task: "task-1" });
    assert.equal(readTask(main), "task-1");
    writeState(main, "task", { task: "" });
    assert.throws(() => readTask(main), /must hold/);
  });
});

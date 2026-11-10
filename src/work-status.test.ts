import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { cleanUp, config, repository, run } from "./testing.ts";
import { type Pull, parseLive, statusRows } from "./work-status.ts";
import { writeState } from "./work-state.ts";

afterEach(cleanUp);

describe("work status", () => {
  it("reads the live commit from a bare sha or a JSON field, and refuses anything else", () => {
    assert.equal(parseLive("0123abc\n", null), "0123abc");
    assert.equal(parseLive('{"status":"ok","build":"89abcdef"}', "build"), "89abcdef");
    assert.throws(() => parseLive('{"status":"ok"}', "build"), /didn't give a commit sha in "build"/);
    assert.throws(() => parseLive("starting up", null), /didn't give a commit sha/);
  });

  it("says, for each checkout, its task, edits, checks, pull request and whether production runs it", () => {
    const { main, root } = repository();
    const settings = config();
    const live = run(main, ["rev-parse", "HEAD"]);
    const feature = join(root, "feature");
    run(main, ["worktree", "add", "-qb", "agent/feature", feature, "origin/main"]);
    writeFileSync(join(feature, "change.ts"), "export const changed = true;\n");
    run(feature, ["add", "."]);
    run(feature, ["commit", "-qm", "change"]);
    writeState(feature, "task", { task: "task-7" });
    const head = run(feature, ["rev-parse", "HEAD"]);
    const pulls: Pull[] = [{ number: 12, url: "https://example.com/pull/12", state: "OPEN", headRefName: "agent/feature", headRefOid: head, mergeCommit: null }];
    const [mainRow, featureRow] = statusRows(main, settings, [main, feature], pulls, live);
    assert.deepEqual(mainRow, { branch: "main", task: "-", behind: "0", ahead: "0", edits: "no", checks: "not run", pr: "none found", live: "yes" });
    assert.deepEqual(featureRow, { branch: "agent/feature", task: "task-7", behind: "0", ahead: "1", edits: "no", checks: "not run", pr: "#12 OPEN", live: "no" });
    // Squash-merged and deployed: the pull request's merge commit is in production.
    run(main, ["merge", "-q", "--squash", "agent/feature"]);
    run(main, ["commit", "-qm", "squashed"]);
    const merged: Pull[] = [{ ...pulls[0]!, state: "MERGED", mergeCommit: run(main, ["rev-parse", "HEAD"]) }];
    const [, after] = statusRows(main, settings, [main, feature], merged, run(main, ["rev-parse", "HEAD"]));
    assert.equal(after?.live, "yes");
    assert.equal(statusRows(main, settings, [feature], merged, null)[0]?.live, "not configured");
  });
});

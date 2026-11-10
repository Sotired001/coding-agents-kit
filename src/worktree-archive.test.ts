import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { cleanUp, config, repository, run } from "./testing.ts";
import { writeState } from "./work-state.ts";
import { activeWorktree, archiveMerged, archiveWorktree, Kept, type PullsByBranch } from "./worktree-archive.ts";

afterEach(() => { mock.restoreAll(); cleanUp(); });

const settings = config({ worktrees: { copy: ["node_modules"] } });
const nobody = () => [];
const notMerged = () => false;

function fixture() {
  mock.method(console, "error", () => {});
  const { root, main } = repository({ ".gitignore": ".worktrees/\n.env\nnode_modules/\n" });
  const path = join(main, ".worktrees", "finished");
  run(main, ["worktree", "add", "-qb", "feature", path]);
  return { root, main, path };
}

describe("archiving finished worktrees", () => {
  it("archives ignored local files and the task, keeps the branch, and removes the checkout", () => {
    const { main, path, root } = fixture();
    writeFileSync(join(path, ".env"), "SYNTHETIC=fixture\n");
    mkdirSync(join(path, "node_modules")); writeFileSync(join(path, "node_modules", "generated"), "generated");
    writeState(path, "task", { task: "task-fixture" });
    const archive = archiveWorktree(main, "finished", settings, nobody, notMerged);
    assert.equal(existsSync(path), false);
    assert.equal(run(main, ["rev-parse", "feature"]), run(main, ["rev-parse", "main"]));
    const restored = join(root, "restore"); mkdirSync(restored);
    execFileSync("tar", ["-xf", join(archive, "files.tar"), "-C", restored]);
    assert.equal(readFileSync(join(restored, ".env"), "utf8"), "SYNTHETIC=fixture\n");
    assert.equal(existsSync(join(restored, "node_modules")), false);
    assert.deepEqual(JSON.parse(readFileSync(join(archive, "agents-kit-task.json"), "utf8")), { task: "task-fixture" });
  });

  it("refuses untracked work, locks, unmerged commits and a checkout a process is using", () => {
    const { main, path } = fixture();
    writeFileSync(join(path, "work.ts"), "unfinished");
    assert.throws(() => archiveWorktree(main, "finished", settings, nobody, notMerged), /uncommitted/);
    rmSync(join(path, "work.ts"));
    run(main, ["worktree", "lock", path]);
    assert.throws(() => archiveWorktree(main, "finished", settings, nobody, notMerged), /locked/);
    run(main, ["worktree", "unlock", path]);
    run(path, ["commit", "--allow-empty", "-qm", "unfinished"]);
    assert.throws(() => archiveWorktree(main, "finished", settings, nobody, notMerged), Kept);
    assert.equal(existsSync(path), true);
    assert.equal(activeWorktree(path, [`${path}/src`]), true);
    assert.equal(activeWorktree(path, [`${path}-other`]), false);
    assert.throws(() => archiveWorktree(main, "finished", settings, () => [path], notMerged), /active process/);
  });

  it("archives a squash-merged branch only when its merged pull request ends at the worktree's HEAD", () => {
    const { main, path } = fixture();
    run(path, ["commit", "--allow-empty", "-qm", "the change, squash-merged"]);
    const head = run(path, ["rev-parse", "HEAD"]);
    assert.throws(() => archiveWorktree(main, "finished", settings, nobody, (_branch, merged) => merged === "a later commit"), /no merged pull request/);
    assert.equal(existsSync(path), true);
    archiveWorktree(main, "finished", settings, nobody, (branch, merged) => branch === "feature" && merged === head);
    assert.equal(existsSync(path), false);
    assert.equal(run(main, ["rev-parse", "feature"]), head);
  });

  it("leaves a new worktree alone, and the one just made, and archives an old one with nothing in it", () => {
    const { main, path } = fixture();
    const noPulls = (): PullsByBranch => new Map();
    // Just made: on main's tip and clean, so it looks merged, but it was used moments ago.
    assert.deepEqual(archiveMerged(main, settings, nobody, noPulls), []);
    assert.equal(existsSync(path), true);
    // The same kind of worktree when its last checkout was long ago.
    const old = join(main, ".worktrees", "old");
    run(main, ["worktree", "add", "-qb", "old-branch", old]);
    const reflog = join(run(old, ["rev-parse", "--absolute-git-dir"]), "logs", "HEAD");
    writeFileSync(reflog, readFileSync(reflog, "utf8").replace(/> \d+ ([+-]\d{4})\t/gu, "> 1759276800 $1\t"));
    assert.deepEqual(archiveMerged(main, settings, nobody, noPulls, "old"), []);
    assert.deepEqual(archiveMerged(main, settings, nobody, noPulls), ["old"]);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(path), true);
  });
});

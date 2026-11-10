import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { cleanUp, config, repository, run, temporaryDirectory } from "./testing.ts";
import { readTask } from "./work-state.ts";
import { makeWorktree, newestBuild } from "./worktree.ts";

afterEach(cleanUp);

const build = { path: "target", marker: "debug/deps", skip: ["incremental"] };

function checkoutWithBuild(main: string, checkout: string, secondsAgo: number): void {
  const marker = join(main, checkout, "target", "debug", "deps");
  mkdirSync(marker, { recursive: true });
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(marker, when, when);
}

describe("newestBuild", () => {
  it("picks the checkout, main or worktree, whose build ran last", () => {
    const main = temporaryDirectory("wt");
    checkoutWithBuild(main, "", 300);
    checkoutWithBuild(main, ".worktrees/older", 200);
    checkoutWithBuild(main, ".worktrees/newest", 10);
    mkdirSync(join(main, ".worktrees/never-built"), { recursive: true });
    assert.equal(newestBuild(main, config(), build), join(main, ".worktrees/newest/target"));
  });

  it("finds nothing when no checkout has built", () => {
    assert.equal(newestBuild(temporaryDirectory("wt"), config(), build), undefined);
  });
});

describe("makeWorktree", () => {
  it("makes a branch from the remote's tip with the dependencies and newest build in place, and records the task", () => {
    const { main } = repository({ ".gitignore": ".worktrees/\nnode_modules/\ntarget/\n" });
    mkdirSync(join(main, "node_modules", "example-dep"), { recursive: true });
    writeFileSync(join(main, "node_modules", "example-dep", "index.js"), "module.exports = 1;\n");
    checkoutWithBuild(main, "", 5);
    mkdirSync(join(main, "target", "debug", "incremental"));
    writeFileSync(join(main, "target", "debug", "deps", "lib.rlib"), "built");
    const settings = config({ worktrees: { copy: ["node_modules"], copyNewest: [build] } });
    const path = makeWorktree(main, settings, "fix-login", "task-3");
    assert.equal(path, join(main, ".worktrees", "fix-login"));
    assert.equal(run(path, ["branch", "--show-current"]), "agent/fix-login");
    assert.equal(run(path, ["rev-parse", "HEAD"]), run(main, ["rev-parse", "origin/main"]));
    assert.equal(readFileSync(join(path, "node_modules", "example-dep", "index.js"), "utf8"), "module.exports = 1;\n");
    assert.equal(readFileSync(join(path, "target", "debug", "deps", "lib.rlib"), "utf8"), "built");
    assert.equal(existsSync(join(path, "target", "debug", "incremental")), false);
    assert.equal(readTask(path), "task-3");
    assert.equal(run(path, ["status", "--porcelain"]), "");
  });

  it("refuses a bad name, an existing worktree, and a missing folder to copy", () => {
    const { main } = repository({ ".gitignore": ".worktrees/\n" });
    assert.throws(() => makeWorktree(main, config(), "Fix_Login"), /lowercase/);
    makeWorktree(main, config(), "one");
    assert.throws(() => makeWorktree(main, config(), "one"), /already exists/);
    assert.throws(() => makeWorktree(main, config({ worktrees: { copy: ["node_modules"] } }), "two"), /no node_modules/);
  });
});

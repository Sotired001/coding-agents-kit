import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { type DeployConfig, deploy, parseDeployConfig, rollback, tryLock, unlock } from "./deploy-queue.ts";
import { cleanUp, repository, run, temporaryDirectory } from "./testing.ts";

afterEach(() => { mock.restoreAll(); cleanUp(); });

/** A shared repository, a server folder with a bare clone of it, and a config whose health check fails for a release
 * that contains a file named BROKEN. */
function server(): { main: string; settings: DeployConfig } {
  mock.method(console, "error", () => {});
  const { main, remote } = repository();
  const root = temporaryDirectory("server");
  const repo = join(root, "repo.git");
  execFileSync("git", ["clone", "-q", "--bare", remote, repo]);
  execFileSync("git", [`--git-dir=${repo}`, "remote", "set-url", "origin", remote]);
  const settings = parseDeployConfig({
    root, repo, branch: "main", build: "echo built > BUILT", health: 'test -f "$RELEASE_DIR/BUILT" && test ! -f "$RELEASE_DIR/BROKEN"',
    healthTimeoutSeconds: 1, lockWaitSeconds: 5, keepReleases: 3,
    onFailure: 'echo "$DEPLOY_FAILURE" >> failures.log',
  });
  return { main, settings };
}

function push(main: string, file: string, text = "x\n"): string {
  writeFileSync(join(main, file), text);
  run(main, ["add", "."]);
  run(main, ["commit", "-qm", `add ${file}`]);
  run(main, ["push", "-q", "origin", "main"]);
  return run(main, ["rev-parse", "HEAD"]);
}

const live = (settings: DeployConfig) => readFileSync(join(settings.root, "current", ".release-sha"), "utf8").trim();

describe("deploy queue", () => {
  it("ships the tip, then does nothing while the tip is live", async () => {
    const { main, settings } = server();
    const first = await deploy(settings, false);
    assert.equal(first.status, 0, first.message);
    assert.equal(live(settings), run(main, ["rev-parse", "HEAD"]));
    assert.match((await deploy(settings, false)).message, /nothing new/);
    const second = push(main, "feature.txt");
    assert.equal((await deploy(settings, false)).status, 0);
    assert.equal(live(settings), second);
  });

  it("leaves the tip to a deploy already waiting in line", async () => {
    const { main, settings } = server();
    await deploy(settings, false);
    push(main, "feature.txt");
    const waiting = join(settings.root, ".deploy-waiting.lock");
    assert.equal(tryLock(waiting), true); // this process stands in for the deploy that is waiting
    const outcome = await deploy(settings, false);
    unlock(waiting);
    assert.equal(outcome.status, 0);
    assert.match(outcome.message, /already waiting/);
  });

  it("changes nothing live when the build fails", async () => {
    const { main, settings } = server();
    await deploy(settings, false);
    const before = live(settings);
    push(main, "feature.txt");
    const outcome = await deploy({ ...settings, build: "exit 1" }, false);
    assert.equal(outcome.status, 1);
    assert.match(outcome.message, /build .* failed; nothing live changed/);
    assert.equal(live(settings), before);
    assert.equal(existsSync(join(settings.root, ".rollback-hold.json")), false);
  });

  it("switches back when the health check fails, holds deploys, and lets only --fixed end the hold", async () => {
    const { main, settings } = server();
    await deploy(settings, false);
    const good = live(settings);
    push(main, "BROKEN");
    const broken = await deploy(settings, false);
    assert.equal(broken.status, 1);
    assert.match(broken.message, /failed its health check; .* is live again/);
    assert.equal(live(settings), good);
    assert.match(readFileSync(join(settings.root, "failures.log"), "utf8"), /failed its health check/);
    // Another merge that doesn't fix it: held.
    push(main, "unrelated.txt");
    const held = await deploy(settings, false);
    assert.equal(held.status, 1);
    assert.match(held.message, /deploys are held/);
    assert.equal(live(settings), good);
    // The fix ships with --fixed and ends the hold.
    run(main, ["rm", "-q", "BROKEN"]);
    run(main, ["commit", "-qm", "fix"]);
    run(main, ["push", "-q", "origin", "main"]);
    const fixed = await deploy(settings, true);
    assert.equal(fixed.status, 0, fixed.message);
    assert.match(fixed.message, /no longer held/);
    assert.equal(live(settings), run(main, ["rev-parse", "HEAD"]));
    assert.equal(existsSync(join(settings.root, ".rollback-hold.json")), false);
  });

  it("rolls back by hand to the release the live one replaced, and holds deploys", async () => {
    const { main, settings } = server();
    await deploy(settings, false);
    const first = live(settings);
    push(main, "feature.txt");
    await deploy(settings, false);
    const outcome = await rollback(settings);
    assert.equal(outcome.status, 0, outcome.message);
    assert.equal(live(settings), first);
    assert.match(outcome.message, /deploys are held/);
    assert.equal((await deploy(settings, false)).status, 1);
  });

  it("keeps only the newest releases, never the live one or the one before it", async () => {
    const { main, settings } = server();
    for (let index = 0; index < 5; index++) {
      push(main, `file-${index}.txt`);
      assert.equal((await deploy(settings, false)).status, 0);
    }
    const releases = execFileSync("ls", [join(settings.root, "releases")], { encoding: "utf8" }).trim().split("\n");
    assert.equal(releases.length, 3);
    assert.ok(releases.includes(readlinkSync(join(settings.root, "current")).replace("releases/", "")));
  });

  it("refuses an unknown key or a missing command in its config", () => {
    assert.throws(() => parseDeployConfig({ root: "/srv/app", repo: "/srv/app/repo.git", branch: "main", build: "true", health: "true", restart: "x" }), /unknown key restart/);
    assert.throws(() => parseDeployConfig({ root: "/srv/app", repo: "/srv/app/repo.git", branch: "main", build: "true" }), /health must be/);
  });
});

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { defaults, loadConfig, parseConfig } from "./config.ts";
import { cleanUp, temporaryDirectory } from "./testing.ts";

afterEach(cleanUp);

describe("config", () => {
  it("gives the defaults for an empty object and for a repo without the file", () => {
    assert.deepEqual(parseConfig({}), defaults);
    assert.deepEqual(loadConfig(temporaryDirectory("config")), defaults);
  });

  it("reads every section and fills in what is left out", () => {
    const directory = temporaryDirectory("config");
    writeFileSync(join(directory, "agents-kit.config.json"), JSON.stringify({
      mainBranch: "trunk",
      worktrees: { copy: ["node_modules"], copyNewest: [{ path: "target", marker: "debug/deps", skip: ["incremental"] }] },
      checks: { commands: [{ label: "typecheck", run: "npm run typecheck", weight: 2 }, { label: "lint", run: "npm run lint" }], budget: 3 },
      status: { liveCommand: "curl -fsS https://app.example.com/health", liveField: "build" },
    }));
    const config = loadConfig(directory);
    assert.equal(config.mainBranch, "trunk");
    assert.equal(config.remote, "origin");
    assert.equal(config.worktrees.branchPrefix, "agent/");
    assert.deepEqual(config.worktrees.copyNewest, [{ path: "target", marker: "debug/deps", skip: ["incremental"] }]);
    assert.deepEqual(config.checks.commands.map(command => command.weight), [2, 1]);
    assert.equal(config.checks.budget, 3);
    assert.equal(config.status.liveField, "build");
  });

  it("fails loudly on unknown keys, wrong types and repeated labels instead of using a default", () => {
    assert.throws(() => parseConfig({ mainbranch: "main" }), /unknown key mainbranch/);
    assert.throws(() => parseConfig({ worktrees: { copy: "node_modules" } }), /list of strings/);
    assert.throws(() => parseConfig({ checks: { commands: [{ label: "a" }] } }), /run must be/);
    assert.throws(() => parseConfig({ checks: { commands: [{ label: "a", run: "x" }, { label: "a", run: "y" }] } }), /two checks/);
    assert.throws(() => parseConfig({ checks: { budget: 2.5 } }), /whole number/);
    assert.throws(() => parseConfig([]), /JSON object/);
  });
});

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { autoBudget, check, runCommand, runGate } from "./check.ts";
import { cleanUp, config, repository } from "./testing.ts";
import { readCheckReceipt, receiptStatus } from "./work-state.ts";

afterEach(cleanUp);

describe("check gate", () => {
  it("runs both compilers together only on large hosts, and small or low-memory hosts in turn", () => {
    assert.equal(autoBudget(32, 16 * 1024 ** 3), 4);
    assert.equal(autoBudget(12, 16 * 1024 ** 3), 3);
    assert.equal(autoBudget(32, 12 * 1024 ** 3), 3);
    assert.equal(autoBudget(2, 16 * 1024 ** 3), 1);
    assert.equal(autoBudget(32, 4 * 1024 ** 3), 1);
  });

  it("refuses to pass with no commands configured", async () => {
    await assert.rejects(runGate([], { budget: 1, signal: new AbortController().signal, run: async () => 0 }), /checks.commands is empty/);
  });

  it("passes the same cancellation signal to every check, and fails on a failed or cancelled one", async () => {
    const commands = [{ label: "a", run: "a", weight: 1 }, { label: "b", run: "b", weight: 1 }];
    const signal = new AbortController().signal;
    const seen: string[] = [];
    const passed = await runGate(commands, { budget: 2, signal, run: async (command, current) => { assert.equal(current, signal); seen.push(command.label); return 0; } });
    assert.equal(passed.status, 0); assert.deepEqual(seen.sort(), ["a", "b"]);
    assert.equal((await runGate(commands, { budget: 2, signal, run: async command => command.label === "b" ? 1 : 0 })).status, 1);
    const controller = new AbortController();
    assert.equal((await runGate(commands, { budget: 1, signal: controller.signal, run: async () => { controller.abort(); return 0; } })).status, 1);
  });

  it("kills a running command's whole process group when cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const status = runCommand("sleep 30 & sleep 30; wait", process.cwd(), controller.signal);
    setTimeout(() => controller.abort(), 50);
    assert.equal(await status, 1);
    assert.ok(Date.now() - started < 5000);
  });

  it("writes a receipt that work-status reads as passed, FAILED, or stale once the source changes", async () => {
    const { main } = repository();
    const log = mock.method(console, "log", () => {});
    const pass = config({ checks: { commands: [{ label: "ok", run: "true" }, { label: "also ok", run: "exit 0" }] } });
    assert.equal(await check(main, pass, new AbortController().signal), 0);
    assert.equal(readCheckReceipt(main)?.stages.length, 2);
    assert.equal(receiptStatus(main, "origin/main"), "passed");
    writeFileSync(join(main, "README.md"), "edited\n");
    assert.equal(receiptStatus(main, "origin/main"), "stale");
    const fail = config({ checks: { commands: [{ label: "broken", run: "exit 3" }] } });
    assert.equal(await check(main, fail, new AbortController().signal), 1);
    assert.equal(receiptStatus(main, "origin/main"), "FAILED");
    log.mock.restore();
  });

  it("fails when the source changes while the checks run", async () => {
    const { main } = repository();
    const log = mock.method(console, "log", () => {});
    const error = mock.method(console, "error", () => {});
    const editing = config({ checks: { commands: [{ label: "edits", run: "echo changed > README.md" }] } });
    assert.equal(await check(main, editing, new AbortController().signal), 1);
    assert.equal(readCheckReceipt(main)?.sourceChanged, true);
    log.mock.restore(); error.mock.restore();
  });
});

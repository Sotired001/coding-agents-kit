import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { runCheckQueue } from "./check-queue.ts";

describe("bounded check queue", () => {
  it("overlaps small checks with one compiler, never two compilers", async () => {
    let active = 0; let large = 0; let peak = 0;
    const started: string[] = [];
    const results = await runCheckQueue([2, 1, 1, 2, 1].map((weight, index) => ({
      label: String(index), weight, run: async () => {
        active += weight; if (weight === 2) large++;
        peak = Math.max(peak, active); started.push(String(index));
        assert.ok(active <= 3); assert.ok(large <= 1);
        await new Promise(resolve => setTimeout(resolve, 2));
        active -= weight; if (weight === 2) large--;
        return 0;
      },
    })), { budget: 3 });
    assert.equal(peak, 3); assert.equal(started.length, 5);
    assert.equal(results.length, 5);
    assert.ok(results.every(result => result.status === 0 && result.durationMs >= 0));
  });

  it("drains already running work but never starts queued work after a failure", async () => {
    const started: string[] = [];
    const results = await runCheckQueue(["fail", "running", "queued"].map(label => ({
      label, weight: 1, run: async () => {
        started.push(label);
        if (label === "running") await new Promise(resolve => setTimeout(resolve, 5));
        return label === "fail" ? 9 : 0;
      },
    })), { budget: 2, failFast: true });
    assert.deepEqual(started, ["fail", "running"]);
    assert.deepEqual(results.map(result => result.status).sort(), [0, 9]);
  });

  it("stops queued work on cancellation and records a runner that threw", async () => {
    const controller = new AbortController();
    const error = mock.method(console, "error", () => {});
    const queued = mock.fn(async () => 0);
    const results = await runCheckQueue([
      { label: "failed", weight: 1, run: async () => { controller.abort(); throw new Error("spawn failed"); } },
      { label: "queued", weight: 1, run: queued },
    ], { budget: 1, signal: controller.signal });
    assert.equal(queued.mock.callCount(), 0); assert.equal(results[0]?.status, 1);
    error.mock.restore();
  });

  it("runs an oversized check alone and accepts an empty queue", async () => {
    assert.deepEqual(await runCheckQueue([], { budget: 1 }), []);
    const [only] = await runCheckQueue([{ label: "large", weight: 10, run: async () => 0 }], { budget: 1 });
    assert.equal(only?.label, "large"); assert.equal(only?.status, 0);
  });

  it("refuses a budget or weight that is not a positive whole number", async () => {
    await assert.rejects(runCheckQueue([], { budget: 0 }), /budget/);
    await assert.rejects(runCheckQueue([{ label: "x", weight: 1.5, run: async () => 0 }], { budget: 2 }), /weights/);
  });
});

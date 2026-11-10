/** A bounded queue for the check gate. Each check has a weight (a compiler might be 2, a small lint 1); checks run
 * side by side while their weights fit the budget. A check heavier than the budget runs alone. */
export type Check = { label: string; weight: number; run: () => Promise<number> };
export type CheckResult = { label: string; status: number; durationMs: number };

export async function runCheckQueue(
  checks: readonly Check[],
  options: {
    budget: number;
    signal?: AbortSignal;
    failFast?: boolean;
    onResult?: (result: CheckResult) => void;
  },
): Promise<CheckResult[]> {
  if (!Number.isInteger(options.budget) || options.budget < 1) throw new Error("Check budget must be a positive integer");
  if (checks.some(check => !Number.isInteger(check.weight) || check.weight < 1)) throw new Error("Check weights must be positive integers");
  const pending = [...checks];
  const results: CheckResult[] = [];
  const active = new Set<Promise<void>>();
  let used = 0;
  let failed = false;
  while (pending.length || active.size) {
    if (options.signal?.aborted || (failed && options.failFast)) pending.length = 0;
    for (let index = 0; index < pending.length;) {
      const check = pending[index];
      if (!check) throw new Error("Missing queued check");
      const weight = Math.min(check.weight, options.budget);
      if (used + weight > options.budget) { index++; continue; }
      pending.splice(index, 1);
      used += weight;
      const started = performance.now();
      const work: Promise<void> = Promise.resolve().then(check.run).catch((error: unknown) => {
        console.error(`[${check.label}] ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }).then(status => {
        failed ||= status !== 0;
        const result = { label: check.label, status, durationMs: Math.round(performance.now() - started) };
        results.push(result);
        options.onResult?.(result);
      }).finally(() => { used -= weight; active.delete(work); });
      active.add(work);
    }
    if (active.size) await Promise.race(active);
  }
  return results;
}

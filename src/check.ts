// The check gate: every command in checks.commands, run once as the final check before a pull request.
//   node src/check.ts
// The commands run through a bounded queue (src/check-queue.ts) so heavy ones (compilers) don't all start at once.
// The first failure stops queued work; running work finishes. The result is written as a receipt in the checkout's
// Git directory, with a fingerprint of the source, so work-status can say whether it still holds for the code on disk.
// Tests are deliberately not here: put them in the list if you want them, or run them after a deploy (see README).
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";
import { type CheckCommand, type Config, loadConfig } from "./config.ts";
import { type CheckResult, runCheckQueue } from "./check-queue.ts";
import { git, mainCheckout, sourceFingerprint, statePath, writeState } from "./work-state.ts";

const KILL_GRACE_MS = 250;

/** How much may run at once: a large host runs two compilers side by side, a middling one one compiler plus small
 * checks, a small one everything in turn. */
export function autoBudget(cpus = availableParallelism(), memory = process.availableMemory()): number {
  if (cpus >= 16 && memory >= 16 * 1024 ** 3) return 4;
  return cpus >= 4 && memory >= 8 * 1024 ** 3 ? 3 : 1;
}

/** Runs one shell command in its own process group, and kills the whole group when the signal aborts. */
export function runCommand(command: string, cwd: string, signal: AbortSignal): Promise<number> {
  if (signal.aborted) return Promise.resolve(1);
  return new Promise(resolve => {
    let settled = false;
    let cancelled = false;
    const grouped = process.platform !== "win32";
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "inherit", "inherit"], detached: grouped });
    const kill = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    };
    const finish = (status: number) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      resolve(status);
    };
    const cancel = () => {
      if (cancelled || settled) return;
      cancelled = true;
      kill("SIGTERM");
      setTimeout(() => { kill("SIGKILL"); finish(1); }, KILL_GRACE_MS);
    };
    signal.addEventListener("abort", cancel, { once: true });
    child.once("error", error => { console.error(`${command}: ${error.message}`); if (!cancelled) finish(1); });
    child.once("exit", (code, killedBy) => { if (!cancelled) finish(killedBy ? 1 : code ?? 1); });
  });
}

export async function runGate(
  commands: readonly CheckCommand[],
  options: { budget: number; signal: AbortSignal; run: (command: CheckCommand, signal: AbortSignal) => Promise<number>; onResult?: (result: CheckResult) => void },
): Promise<{ status: number; results: CheckResult[] }> {
  if (!commands.length) throw new Error("checks.commands is empty: list the commands the gate runs in agents-kit.config.json");
  const results = await runCheckQueue(commands.map(command => ({
    label: command.label, weight: command.weight, run: () => options.run(command, options.signal),
  })), { budget: options.budget, signal: options.signal, failFast: true, onResult: options.onResult });
  const passed = !options.signal.aborted && results.length === commands.length && results.every(result => result.status === 0);
  return { status: passed ? 0 : 1, results };
}

/** Runs the gate in `root` and writes its receipt. Returns the exit status. */
export async function check(root: string, config: Config, signal: AbortSignal): Promise<number> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const fingerprint = sourceFingerprint(root);
  const head = git(root, ["rev-parse", "HEAD"]);
  const base = git(root, ["merge-base", "HEAD", `${config.remote}/${config.mainBranch}`]);
  const budget = config.checks.budget === "auto" ? autoBudget() : config.checks.budget;
  const { status, results } = await runGate(config.checks.commands, {
    budget, signal, run: (command, active) => runCommand(command.run, root, active),
    onResult: result => console.log(`[${result.label}] ${result.status === 0 ? "passed" : "FAILED"} in ${(result.durationMs / 1000).toFixed(1)}s`),
  });
  const sourceChanged = fingerprint !== sourceFingerprint(root);
  if (sourceChanged) console.error("Source changed while the checks ran; run the gate again for the current tree.");
  const finalStatus = sourceChanged ? 1 : status;
  writeState(root, "checks", { head, fingerprint, base, startedAt, finishedAt: new Date().toISOString(),
    status: finalStatus, durationMs: Math.round(performance.now() - started), sourceChanged, stages: results });
  console.log(`Check receipt: ${statePath(root, "checks")}`);
  return finalStatus;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    if (process.argv.length > 2) throw new Error("Usage: check (no arguments; the commands come from agents-kit.config.json)");
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    const config = loadConfig(mainCheckout(root));
    const deadline = setTimeout(() => { console.error(`The gate took longer than ${config.checks.timeoutMinutes} minutes; stopping it.`); controller.abort(); },
      config.checks.timeoutMinutes * 60 * 1000);
    deadline.unref();
    check(root, config, controller.signal).then(status => { process.exitCode = status; }, (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

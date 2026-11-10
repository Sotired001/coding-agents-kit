// One table that answers "where is this work?": branch, task, ahead/behind main, local edits, the check gate's
// receipt, the pull request, and whether production runs it.
//   node src/work-status.ts          this checkout
//   node src/work-status.ts --all    every worktree of the repository
// Pull requests come from the GitHub CLI (gh). What is live comes from status.liveCommand: a shell command that
// prints either a commit sha or JSON with the sha in status.liveField (for example a health endpoint read with curl).
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { type Config, loadConfig } from "./config.ts";
import { git, mainCheckout, readCheckReceipt, readTask, receiptStatus, statePath, worktreePaths } from "./work-state.ts";

export type Pull = { number: number; url: string; state: string; headRefName: string; headRefOid: string; mergeCommit: string | null };

function pullFrom(row: unknown): Pull {
  const get = (name: string): unknown => typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  const number = get("number"); const url = get("url"); const state = get("state");
  const headRefName = get("headRefName"); const headRefOid = get("headRefOid"); const merge = get("mergeCommit");
  if (typeof number !== "number" || typeof url !== "string" || typeof state !== "string" || typeof headRefName !== "string" || typeof headRefOid !== "string") {
    throw new Error(`gh pr list returned an unexpected row: ${JSON.stringify(row)}`);
  }
  const oid: unknown = typeof merge === "object" && merge !== null ? Reflect.get(merge, "oid") : null;
  if (oid !== null && typeof oid !== "string") throw new Error(`gh pr list returned a merge commit without an oid: ${JSON.stringify(row)}`);
  return { number, url, state, headRefName, headRefOid, mergeCommit: oid };
}

export function listPulls(root: string): Pull[] {
  const text = execFileSync("gh", ["pr", "list", "--state", "all", "--limit", "1000", "--json", "number,url,state,headRefName,headRefOid,mergeCommit"],
    { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("gh pr list didn't return a list");
  return parsed.map(pullFrom);
}

/** Reads the commit production runs from the output of status.liveCommand. */
export function parseLive(output: string, liveField: string | null): string {
  let build: unknown = output.trim();
  if (liveField) {
    const parsed: unknown = JSON.parse(output);
    build = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, liveField) : undefined;
  }
  if (typeof build !== "string" || !/^[a-f0-9]{7,40}$/u.test(build)) {
    throw new Error(`status.liveCommand didn't give a commit sha${liveField ? ` in "${liveField}"` : ""}: ${output.slice(0, 200)}`);
  }
  return build;
}

export function liveBuild(config: Config): string | null {
  if (!config.status.liveCommand) return null;
  const output = execFileSync(config.status.liveCommand, { shell: "/bin/sh", encoding: "utf8", timeout: 30_000 });
  return parseLive(output, config.status.liveField);
}

export type Row = { branch: string; task: string; behind: string; ahead: string; edits: string; checks: string; pr: string; live: string };

export function statusRows(root: string, config: Config, paths: readonly string[], pulls: readonly Pull[], live: string | null): Row[] {
  const main = `${config.remote}/${config.mainBranch}`;
  const liveAncestors = live ? new Set(git(root, ["rev-list", git(root, ["rev-parse", `${live}^{commit}`])]).split("\n")) : null;
  return paths.map(path => {
    const head = git(path, ["rev-parse", "HEAD"]);
    const branch = git(path, ["branch", "--show-current"]);
    const pr = pulls.find(pull => pull.headRefName === branch && (pull.headRefOid === head || pull.state === "OPEN"));
    const [behind = "?", ahead = "?"] = git(path, ["rev-list", "--left-right", "--count", `${main}...HEAD`]).split(/\s+/u);
    const dirty = git(path, ["status", "--porcelain"]).length > 0;
    let shipped = "not configured";
    if (liveAncestors) {
      const isLive = liveAncestors.has(head) || Boolean(pr?.mergeCommit && liveAncestors.has(pr.mergeCommit));
      shipped = isLive ? (dirty ? "HEAD only; local edits" : "yes") : "no";
    }
    return { branch: branch || `detached ${head.slice(0, 9)}`, task: readTask(path) ?? "-", behind, ahead, edits: dirty ? "yes" : "no",
      checks: receiptStatus(path, main), pr: pr ? `#${pr.number} ${pr.state}` : "none found", live: shipped };
  });
}

export function status(root: string, config: Config, all: boolean): void {
  // Fetch once: never call a branch merged or current from an old remote ref.
  git(root, ["fetch", "--quiet", config.remote, config.mainBranch]);
  const pulls = listPulls(root);
  const live = liveBuild(config);
  console.log(live ? `Production: ${live}` : "Production: not configured (status.liveCommand)");
  console.table(statusRows(root, config, all ? worktreePaths(root) : [root], pulls, live));
  if (all) return;
  const branch = git(root, ["branch", "--show-current"]);
  const pr = pulls.find(pull => pull.headRefName === branch);
  if (pr) console.log(pr.url);
  const receipt = readCheckReceipt(root);
  if (receipt) {
    console.log(`Last gate: ${receipt.finishedAt}, ${(receipt.durationMs / 1000).toFixed(1)}s total; ${statePath(root, "checks")}`);
    console.table(receipt.stages.map(stage => ({ check: stage.label, seconds: +(stage.durationMs / 1000).toFixed(1), status: stage.status })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== "--all")) throw new Error("Usage: work-status [--all]");
    const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
    status(root, loadConfig(mainCheckout(root)), args.includes("--all"));
  } catch (error) {
    console.error(`Work status failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

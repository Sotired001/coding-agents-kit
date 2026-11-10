// Archives finished agent worktrees: merged, clean, not in use, and untouched for a while. The branch stays,
// the checkout's files (ignored local files included) go into a tar file, and the checkout is removed.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Config } from "./config.ts";
import { git, statePath } from "./work-state.ts";

const NAME = /^[a-z0-9][a-z0-9-]*$/u;

/** Never move a checkout out from under a running shell, editor, or agent. */
export function activeWorktree(path: string, processCwds: readonly string[]): boolean {
  const root = resolve(path);
  return processCwds.some(cwd => resolve(cwd) === root || resolve(cwd).startsWith(`${root}${sep}`));
}

/** The working directory of every process this user owns. Linux only: it reads /proc. Some processes (systemd's user
 * manager, setuid helpers) hide their working directory even from their owner; those are named on stderr and left out,
 * since they are services rather than shells or agents sitting in a checkout. */
export function processDirectories(): string[] {
  if (process.platform !== "linux") throw new Error("Archiving worktrees needs Linux /proc to see which ones are in use");
  const hidden: string[] = [];
  const directories = readdirSync("/proc").filter(name => /^\d+$/u.test(name)).flatMap(pid => {
    const path = `/proc/${pid}`;
    try {
      if (statSync(path).uid !== process.getuid?.()) return [];
      return [readlinkSync(`${path}/cwd`)];
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "ENOENT" || code === "ESRCH") return [];
      if (code === "EACCES") { hidden.push(pid); return []; }
      throw error;
    }
  });
  if (hidden.length) console.error(`can't see the working directory of process ${hidden.join(", ")}; assuming it isn't in a worktree`);
  return directories;
}

/** A worktree that stays where it is, and why. Anything else that goes wrong while archiving is an error. */
export class Kept extends Error {}

/** Whether a branch's work is on the main branch. With squash merges a merged branch is almost never an ancestor of
 * main, so its pull request must be merged with the worktree's HEAD as its last commit: nothing committed after the
 * merge is lost. */
export type Merged = (branch: string, head: string) => boolean;

export type PullsByBranch = Map<string, { head: string; mergedAt: number }[]>;

function field(row: unknown, name: string): string {
  const value: unknown = typeof row === "object" && row !== null ? Reflect.get(row, name) : undefined;
  if (typeof value !== "string") throw new Error(`gh pr list returned a merged pull request without ${name}: ${JSON.stringify(row)}`);
  return value;
}

/** Merged pull requests by branch, from the GitHub CLI (one call for every worktree). */
export function mergedPullRequests(main: string): PullsByBranch {
  const text = execFileSync("gh", ["pr", "list", "--state", "merged", "--limit", "1000", "--json", "headRefName,headRefOid,mergedAt"], {
    cwd: main, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("gh pr list didn't return a list");
  const byBranch: PullsByBranch = new Map();
  for (const row of parsed) {
    const branch = field(row, "headRefName");
    byBranch.set(branch, [...(byBranch.get(branch) ?? []), { head: field(row, "headRefOid"), mergedAt: Date.parse(field(row, "mergedAt")) }]);
  }
  return byBranch;
}

function onMain(path: string, config: Config): boolean {
  try {
    git(path, ["merge-base", "--is-ancestor", "HEAD", `${config.remote}/${config.mainBranch}`]);
    return true;
  } catch {
    return false;
  }
}

export function archiveWorktree(main: string, name: string, config: Config, directories: () => string[], merged: Merged): string {
  if (!NAME.test(name)) throw new Error("Use the worktree's directory name, with lowercase letters, digits and dashes");
  const path = join(main, config.worktrees.dir, name);
  if (!existsSync(path)) throw new Error(`No worktree at ${path}`);
  const common = git(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const metadata = git(path, ["rev-parse", "--absolute-git-dir"]);
  if (dirname(metadata) !== join(common, "worktrees")) throw new Error("Not a linked worktree of this repository");
  if (existsSync(join(metadata, "locked"))) throw new Kept("Worktree is locked");
  if (activeWorktree(path, directories())) throw new Kept("Worktree has an active process; leave it in place");
  if (git(path, ["status", "--porcelain"])) throw new Kept("Worktree has uncommitted files; leave it in place");
  git(main, ["fetch", "--quiet", config.remote, config.mainBranch]);
  const branch = git(path, ["branch", "--show-current"]);
  if (!branch || branch === config.mainBranch) throw new Kept("Only a merged feature branch can be archived");
  const head = git(path, ["rev-parse", "HEAD"]);
  if (!onMain(path, config) && !merged(branch, head)) {
    throw new Kept(`${branch} isn't on ${config.mainBranch} and has no merged pull request ending at ${head.slice(0, 9)}`);
  }
  const archive = join(common, "agents-kit-archives", `${name}-${new Date().toISOString().replaceAll(":", "-")}`);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  // Keep ignored local settings too. Only what can be made again (dependencies, builds) is left out.
  const excluded = ["./.git", ...config.worktrees.copy, ...config.worktrees.copyNewest.map(entry => entry.path)]
    .map(entry => `--exclude=${entry.startsWith("./") ? entry : `./${entry}`}`);
  execFileSync("tar", ["-cf", join(archive, "files.tar"), ...excluded, "-C", path, "."], { stdio: "inherit" });
  for (const state of ["checks", "task"]) {
    const file = statePath(path, state);
    if (existsSync(file)) copyFileSync(file, join(archive, basename(file)));
  }
  // Check again right before removing it; Git also refuses to remove changed tracked or untracked files.
  if (activeWorktree(path, directories())) throw new Kept(`Worktree became active; kept it, and the archive ${archive}`);
  if (git(path, ["rev-parse", "HEAD"]) !== head) throw new Kept(`Worktree moved; kept it, and the archive ${archive}`);
  git(main, ["worktree", "remove", path]);
  console.error(`Archived ${name}; branch ${branch} kept. Restore with git worktree add <path> ${branch}, then extract files.tar there.`);
  return archive;
}

/** When the worktree last changed HEAD (made, checked out, committed): the newest entry of its own HEAD reflog. */
function lastActivity(path: string): number {
  // %gd with --date=unix is the reflog entry's own time (HEAD@{<seconds>}); %ct would be the commit's.
  const entry = git(path, ["log", "-g", "-1", "--date=unix", "--format=%gd", "HEAD"]);
  const seconds = /^HEAD@\{(\d+)\}$/u.exec(entry)?.[1];
  if (!seconds) throw new Error(`${path} has no HEAD reflog to say when it was last used (got "${entry}")`);
  return Number(seconds) * 1000;
}

/** Archives every worktree that is merged, clean, not in use, and untouched for the grace period. Each one archived
 * is returned; the rest stay. `except` is left out (the worktree that was just made). */
export function archiveMerged(
  main: string, config: Config, directories: () => string[], listPulls: () => PullsByBranch, except?: string,
): string[] {
  const worktrees = join(main, config.worktrees.dir);
  if (!existsSync(worktrees)) return [];
  const now = Date.now();
  const grace = config.worktrees.graceHours * 60 * 60 * 1000;
  // Asked once, and only when some worktree is old enough to need the answer.
  let pulls: PullsByBranch | undefined;
  // The session that merged it may still deploy from it, so a pull request must be merged a while too.
  const merged: Merged = (branch, head) => {
    pulls ??= listPulls();
    return (pulls.get(branch) ?? []).some(pull => pull.head === head && now - pull.mergedAt > grace);
  };
  const archived: string[] = [];
  for (const name of readdirSync(worktrees)) {
    if (name === except || !NAME.test(name) || !existsSync(join(worktrees, name, ".git"))) continue;
    // A new worktree sits on main's tip with nothing in it yet, so it looks merged: leave it alone a while.
    if (now - lastActivity(join(worktrees, name)) < grace) continue;
    try {
      archiveWorktree(main, name, config, directories, merged);
      archived.push(name);
    } catch (error) {
      if (!(error instanceof Kept)) throw error;
    }
  }
  return archived;
}

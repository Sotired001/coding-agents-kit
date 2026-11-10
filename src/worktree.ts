// A ready-to-work checkout for one agent task, in one step:
//   node src/worktree.ts <name> [--task <id>]   make <worktrees.dir>/<name> on branch <branchPrefix><name>
//   node src/worktree.ts --archive <name>       archive one merged worktree now
//   node src/worktree.ts --archive-merged       archive every merged, clean, idle one now
// The new checkout starts at the tip of <remote>/<mainBranch>. Folders listed in worktrees.copy (node_modules, say)
// are copied from the main checkout, reflinked where the file system can, so it is quick and takes little space.
// worktrees.copyNewest takes a build folder from whichever checkout built last. Then the finished worktrees are archived.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Config, type CopyNewest, loadConfig } from "./config.ts";
import { git, mainCheckout, writeState } from "./work-state.ts";
import { archiveMerged, archiveWorktree, mergedPullRequests, processDirectories } from "./worktree-archive.ts";

/** The checkout (main or any worktree) whose copy of `entry` changed last, judged by its marker folder (a folder
 * every build writes to). Returns the folder to copy, or undefined when no checkout has one. */
export function newestBuild(main: string, config: Config, entry: CopyNewest): string | undefined {
  const worktrees = join(main, config.worktrees.dir);
  const checkouts = [main, ...(existsSync(worktrees) ? readdirSync(worktrees).map(name => join(worktrees, name)) : [])];
  let newest: { path: string; time: number } | undefined;
  for (const checkout of checkouts) {
    const marker = join(checkout, entry.path, entry.marker);
    if (!existsSync(marker)) continue;
    const time = statSync(marker).mtimeMs;
    if (!newest || time > newest.time) newest = { path: join(checkout, entry.path), time };
  }
  return newest?.path;
}

function copy(from: string, to: string): void {
  execFileSync("cp", ["-a", "--reflink=auto", from, to]);
}

/** Copies a build folder, leaving out the names in `skip` one level down (caches that belong to the checkout that
 * made them, such as incremental compiler state). */
export function copyBuild(from: string, to: string, skip: readonly string[]): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (!entry.isDirectory()) { copy(source, to); continue; }
    mkdirSync(join(to, entry.name));
    for (const inner of readdirSync(source)) {
      if (!skip.includes(inner)) copy(join(source, inner), join(to, entry.name));
    }
  }
}

export function makeWorktree(main: string, config: Config, name: string, task?: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error(`name it with lowercase letters, digits and dashes (got "${name}")`);
  const path = join(main, config.worktrees.dir, name);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  for (const entry of config.worktrees.copy) {
    if (!existsSync(join(main, entry))) throw new Error(`the main checkout has no ${entry} to copy; make it there first (worktrees.copy)`);
  }
  git(main, ["fetch", "--quiet", config.remote, config.mainBranch]);
  git(main, ["worktree", "add", "--quiet", "-b", `${config.worktrees.branchPrefix}${name}`, path, `${config.remote}/${config.mainBranch}`]);
  for (const entry of config.worktrees.copy) {
    mkdirSync(dirname(join(path, entry)), { recursive: true });
    copy(join(main, entry), join(path, entry));
  }
  for (const entry of config.worktrees.copyNewest) {
    const build = newestBuild(main, config, entry);
    if (build) copyBuild(build, join(path, entry.path), entry.skip);
  }
  if (task) writeState(path, "task", { task });
  return path;
}

function tidy(main: string, config: Config, made?: string): void {
  for (const name of archiveMerged(main, config, processDirectories, () => mergedPullRequests(main), made)) {
    console.error(`archived ${name} (merged)`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const main = mainCheckout(process.cwd());
    const config = loadConfig(main);
    if (args[0] === "--archive" && args.length === 2 && args[1]) {
      console.log(archiveWorktree(main, args[1], config, processDirectories, (branch, head) =>
        (mergedPullRequests(main).get(branch) ?? []).some(pull => pull.head === head)));
    } else if (args[0] === "--archive-merged" && args.length === 1) {
      tidy(main, config);
    } else {
      const [name, option, task] = args;
      if (!name || name.startsWith("-") || (args.length !== 1 && (args.length !== 3 || option !== "--task" || !task?.trim()))) {
        throw new Error("Usage: worktree <name> [--task <id>] | --archive <name> | --archive-merged");
      }
      console.log(makeWorktree(main, config, name, task));
      try {
        tidy(main, config, name);
      } catch (error) {
        console.error(`The worktree is ready; archiving the finished ones failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

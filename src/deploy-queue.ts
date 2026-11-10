// A reference deploy queue for one server, written for this kit (not extracted: see README, "The deploy queue").
// Run it on the server, by whoever just merged:
//   node src/deploy-queue.ts --config <file>              ship the tip of the branch
//   node src/deploy-queue.ts --config <file> --fixed      ship the tip when it holds the fix for a rollback; ends the hold
//   node src/deploy-queue.ts --config <file> --rollback   go back to the release the live one replaced, and hold deploys
// The rules:
// - Nothing new on the branch: do nothing.
// - At most one deploy waits in line. It ships the tip as it is when its turn comes, so a second one waiting would only
//   build the same thing again: it says so and exits 0.
// - A failed build changes nothing that is live.
// - A release that fails its health check after the switch is switched back to the one it replaced, and deploys are
//   held until a deploy with --fixed passes its health check.
// Layout under config.root: releases/<sha>-<time>/, current -> releases/..., history.json, .rollback-hold.json, locks.
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export type DeployConfig = {
  root: string;               // holds the releases, the current link, history and locks
  repo: string;               // a bare clone on the server whose "origin" is the shared repository
  branch: string;
  build: string;              // shell command run inside the new release folder
  activate: string | null;    // shell command run after `current` changes (restart the service); null for none
  health: string;             // shell command; exit 0 means the live release is healthy
  healthTimeoutSeconds: number;
  lockWaitSeconds: number;
  keepReleases: number;
  onFailure: string | null;   // shell command told about every failure (DEPLOY_FAILURE in its environment)
};

export type Outcome = { status: number; message: string };

const KEYS = ["root", "repo", "branch", "build", "activate", "health", "healthTimeoutSeconds", "lockWaitSeconds", "keepReleases", "onFailure"];

export function parseDeployConfig(raw: unknown): DeployConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("deploy config must be a JSON object");
  const get = (name: string): unknown => Reflect.get(raw, name);
  for (const key of Object.keys(raw)) if (!KEYS.includes(key)) throw new Error(`deploy config: unknown key ${key}`);
  const text = (name: string): string => {
    const value = get(name);
    if (typeof value !== "string" || !value.trim()) throw new Error(`deploy config: ${name} must be a non-empty string`);
    return value;
  };
  const optional = (name: string): string | null => (get(name) === undefined || get(name) === null ? null : text(name));
  const count = (name: string, fallback: number): number => {
    const value = get(name);
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`deploy config: ${name} must be a whole number above 0`);
    return value;
  };
  return { root: text("root"), repo: text("repo"), branch: text("branch"), build: text("build"), activate: optional("activate"),
    health: text("health"), healthTimeoutSeconds: count("healthTimeoutSeconds", 90), lockWaitSeconds: count("lockWaitSeconds", 3600),
    keepReleases: count("keepReleases", 5), onFailure: optional("onFailure") };
}

function log(message: string): void {
  console.error(`deploy: ${message}`);
}

// --- locks -----------------------------------------------------------------------------------------------------
// A lock is a file made with O_EXCL holding the owner's pid; one whose owner has died is taken over. On a real server,
// flock(1) is sturdier (the kernel drops it when the process dies); this keeps the reference free of anything but Node.

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function tryLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const owner = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && alive(owner)) return false;
      // The owner is gone: move its file aside (only one process wins the rename) and try again.
      try { renameSync(path, `${path}.stale-${process.pid}`); rmSync(`${path}.stale-${process.pid}`); } catch { /* another process took it over first */ }
    }
  }
  return false;
}

export function unlock(path: string): void {
  if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path);
}

async function waitForLock(path: string, seconds: number): Promise<boolean> {
  const until = Date.now() + seconds * 1000;
  while (!tryLock(path)) {
    if (Date.now() > until) return false;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return true;
}

// --- releases ------------------------------------------------------------------------------------------------------

type HistoryEntry = { release: string; sha: string; at: string; why: string };
type Hold = { release: string; at: string; why: string };

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : fallback;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function shell(command: string, cwd: string, env: Record<string, string>): number {
  const result = spawnSync(command, { cwd, shell: "/bin/sh", stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...env } });
  return result.status ?? 1;
}

function git(config: DeployConfig, args: readonly string[]): string {
  return execFileSync("git", [`--git-dir=${config.repo}`, ...args], { encoding: "utf8" }).trim();
}

function tip(config: DeployConfig): string {
  git(config, ["fetch", "--quiet", "origin", `+refs/heads/${config.branch}:refs/remotes/origin/${config.branch}`]);
  return git(config, ["rev-parse", `refs/remotes/origin/${config.branch}^{commit}`]);
}

function currentRelease(config: DeployConfig): string | null {
  const link = join(config.root, "current");
  return existsSync(link) ? basename(readlinkSync(link)) : null;
}

function liveSha(config: DeployConfig): string | null {
  const release = currentRelease(config);
  return release ? readFileSync(join(config.root, "releases", release, ".release-sha"), "utf8").trim() : null;
}

/** Points `current` at a release in one rename, so there is never a moment without one. */
function switchTo(config: DeployConfig, release: string, why: string): void {
  const link = join(config.root, "current");
  const next = `${link}.next-${process.pid}`;
  rmSync(next, { force: true });
  symlinkSync(join("releases", release), next);
  renameSync(next, link);
  const historyPath = join(config.root, "history.json");
  const history = readJson<HistoryEntry[]>(historyPath, []);
  history.push({ release, sha: readFileSync(join(config.root, "releases", release, ".release-sha"), "utf8").trim(), at: new Date().toISOString(), why });
  writeJson(historyPath, history);
}

/** The release the live one replaced: the newest earlier entry that is neither the live release nor one rolled back. */
function previousRelease(config: DeployConfig): string | null {
  const live = currentRelease(config);
  const history = readJson<HistoryEntry[]>(join(config.root, "history.json"), []);
  const bad = new Set(history.filter(entry => entry.why.startsWith("rolled back from ")).map(entry => entry.why.slice("rolled back from ".length)));
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    if (entry && entry.release !== live && !bad.has(entry.release) && existsSync(join(config.root, "releases", entry.release))) return entry.release;
  }
  return null;
}

/** Activates the live release and waits for its health check. */
async function activateAndCheck(config: DeployConfig): Promise<boolean> {
  const live = join(config.root, "current");
  const env = { RELEASE_DIR: live, RELEASE_SHA: liveSha(config) ?? "" };
  if (config.activate && shell(config.activate, live, env) !== 0) return false;
  const until = Date.now() + config.healthTimeoutSeconds * 1000;
  for (;;) {
    if (shell(config.health, live, env) === 0) return true;
    if (Date.now() > until) return false;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function failure(config: DeployConfig, message: string): Outcome {
  log(message);
  if (config.onFailure && shell(config.onFailure, config.root, { DEPLOY_FAILURE: message }) !== 0) log("the onFailure command failed too");
  return { status: 1, message };
}

function hold(config: DeployConfig, release: string, why: string): void {
  writeJson(join(config.root, ".rollback-hold.json"), { release, at: new Date().toISOString(), why } satisfies Hold);
}

function prune(config: DeployConfig): void {
  const keep = new Set([currentRelease(config), previousRelease(config)]);
  const history = readJson<HistoryEntry[]>(join(config.root, "history.json"), []);
  const newestFirst = [...new Set(history.map(entry => entry.release).reverse())];
  for (const release of newestFirst.slice(config.keepReleases)) {
    if (!keep.has(release)) rmSync(join(config.root, "releases", release), { recursive: true, force: true });
  }
}

// --- the two commands ----------------------------------------------------------------------------------------------

export async function deploy(config: DeployConfig, fixed: boolean): Promise<Outcome> {
  mkdirSync(join(config.root, "releases"), { recursive: true });
  const first = tip(config);
  if (first === liveSha(config)) return { status: 0, message: `nothing new on ${config.branch}: ${first.slice(0, 9)} is already live` };
  const waiting = join(config.root, ".deploy-waiting.lock");
  const deploying = join(config.root, ".deploy.lock");
  if (!tryLock(waiting)) {
    return { status: 0, message: `another deploy is already waiting; it ships ${config.branch} as it is when its turn comes, ${first.slice(0, 9)} included` };
  }
  let mine = false;
  try {
    mine = await waitForLock(deploying, config.lockWaitSeconds);
    if (!mine) return failure(config, `another deploy held the lock for over ${config.lockWaitSeconds} s; nothing deployed`);
  } finally {
    unlock(waiting); // its turn (or its give-up): the next deploy may wait now
  }
  try {
    const held = readJson<Hold | null>(join(config.root, ".rollback-hold.json"), null);
    if (held && !fixed) {
      return failure(config, `deploys are held: ${held.release} was rolled back at ${held.at} (${held.why}). Nothing deployed; ship the fix with --fixed`);
    }
    const sha = tip(config); // the tip as it is now, which may be newer than the one this deploy was started for
    if (sha === liveSha(config)) return { status: 0, message: `${sha.slice(0, 9)} went live while this deploy waited` };
    const release = `${sha.slice(0, 12)}-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
    const folder = join(config.root, "releases", release);
    mkdirSync(folder);
    execFileSync("tar", ["-xf", "-", "-C", folder], { input: execFileSync("git", [`--git-dir=${config.repo}`, "archive", "--format=tar", sha], { maxBuffer: 1024 ** 3 }) });
    writeFileSync(join(folder, ".release-sha"), `${sha}\n`);
    log(`building ${sha.slice(0, 9)} in ${folder}`);
    if (shell(config.build, folder, { RELEASE_DIR: folder, RELEASE_SHA: sha }) !== 0) {
      rmSync(folder, { recursive: true, force: true });
      return failure(config, `the build of ${sha.slice(0, 9)} failed; nothing live changed`);
    }
    const previous = currentRelease(config);
    switchTo(config, release, "deploy");
    if (await activateAndCheck(config)) {
      if (held) rmSync(join(config.root, ".rollback-hold.json"));
      prune(config);
      return { status: 0, message: `${sha.slice(0, 9)} is live${held ? "; deploys are no longer held" : ""}` };
    }
    if (!previous) return failure(config, `${sha.slice(0, 9)} failed its health check and there is no earlier release to go back to: fix forward`);
    switchTo(config, previous, `rolled back from ${release}`);
    hold(config, release, "failed its health check after going live");
    if (!(await activateAndCheck(config))) return failure(config, `${sha.slice(0, 9)} failed its health check, and ${previous} failed after switching back: the service may be down`);
    return failure(config, `${sha.slice(0, 9)} failed its health check; ${previous} is live again. Deploys are held until the fix ships with --fixed`);
  } finally {
    unlock(deploying);
  }
}

export async function rollback(config: DeployConfig): Promise<Outcome> {
  const deploying = join(config.root, ".deploy.lock");
  if (!(await waitForLock(deploying, config.lockWaitSeconds))) return failure(config, "another deploy holds the lock; nothing rolled back");
  try {
    const from = currentRelease(config);
    const to = previousRelease(config);
    if (!from || !to) return failure(config, "there is no earlier release to go back to");
    switchTo(config, to, `rolled back from ${from}`);
    hold(config, from, "rolled back by hand");
    if (!(await activateAndCheck(config))) return failure(config, `rolled back to ${to}, but it failed its health check: the service may be down`);
    return { status: 0, message: `${to} is live; ${from} is marked rolled back; deploys are held until the fix ships with --fixed` };
  } finally {
    unlock(deploying);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--config");
  const file = at >= 0 ? args[at + 1] : undefined;
  const rest = args.filter((_, index) => index !== at && index !== at + 1);
  const run = async (): Promise<Outcome> => {
    if (!file || rest.some(arg => arg !== "--fixed" && arg !== "--rollback") || (rest.includes("--fixed") && rest.includes("--rollback"))) {
      throw new Error("Usage: deploy-queue --config <file> [--fixed | --rollback]");
    }
    const config = parseDeployConfig(JSON.parse(readFileSync(file, "utf8")));
    return rest.includes("--rollback") ? rollback(config) : deploy(config, rest.includes("--fixed"));
  };
  // failure() has already logged every outcome that isn't 0.
  run().then(outcome => { if (outcome.status === 0) log(outcome.message); process.exitCode = outcome.status; }, (error: unknown) => {
    log(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

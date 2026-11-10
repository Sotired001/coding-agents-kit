// Helpers for the kit's own tests: throwaway Git repositories that never read the user's Git settings.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, parseConfig } from "./config.ts";

// Every git process the tests start (directly or through the kit) sees only these settings.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_AUTHOR_NAME = "Fixture";
process.env.GIT_COMMITTER_NAME = "Fixture";
process.env.GIT_AUTHOR_EMAIL = "";
process.env.GIT_COMMITTER_EMAIL = "";

const made: string[] = [];

export function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `agents-kit-${prefix}-`));
  made.push(path);
  return path;
}

export function cleanUp(): void {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
}

export function run(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

/** A main checkout on branch main with one commit, pushed to a bare "origin" beside it. */
export function repository(files: Record<string, string> = { "README.md": "fixture\n" }): { root: string; main: string; remote: string } {
  const root = temporaryDirectory("repo");
  const main = join(root, "main");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", main]);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(main, name), text);
  run(main, ["add", "."]);
  run(main, ["commit", "-qm", "fixture"]);
  run(main, ["remote", "add", "origin", remote]);
  run(main, ["push", "-q", "origin", "main"]);
  run(main, ["fetch", "-q", "origin"]);
  return { root, main, remote };
}

export function config(overrides: Record<string, unknown> = {}): Config {
  return parseConfig(overrides);
}

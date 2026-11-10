// Reads agents-kit.config.json from the root of the main checkout. Every piece of the kit takes its settings from
// here, so nothing about one particular repo, server or team is written into the code.
// Unknown keys and wrong types fail loudly: a typo must never quietly fall back to a default.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE = "agents-kit.config.json";

export type CheckCommand = { label: string; run: string; weight: number };
export type CopyNewest = { path: string; marker: string; skip: string[] };

export type Config = {
  remote: string;
  mainBranch: string;
  worktrees: { dir: string; branchPrefix: string; copy: string[]; copyNewest: CopyNewest[]; graceHours: number };
  checks: { commands: CheckCommand[]; budget: number | "auto"; timeoutMinutes: number };
  status: { liveCommand: string | null; liveField: string | null };
};

export const defaults: Config = {
  remote: "origin",
  mainBranch: "main",
  worktrees: { dir: ".worktrees", branchPrefix: "agent/", copy: [], copyNewest: [], graceHours: 2 },
  checks: { commands: [], budget: "auto", timeoutMinutes: 60 },
  status: { liveCommand: null, liveField: null },
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(where: string, value: Json, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${CONFIG_FILE}: unknown key ${where}${key}`);
  }
}

function text(where: string, value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${CONFIG_FILE}: ${where} must be a non-empty string`);
  return value;
}

function required(where: string, value: unknown): string {
  if (value === undefined) throw new Error(`${CONFIG_FILE}: ${where} must be a non-empty string`);
  return text(where, value, "");
}

function textOrNull(where: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return text(where, value, "");
}

function positive(where: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${CONFIG_FILE}: ${where} must be a positive number`);
  return value;
}

function texts(where: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) throw new Error(`${CONFIG_FILE}: ${where} must be a list of strings`);
  return value.map(String);
}

function section(where: string, value: unknown): Json {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error(`${CONFIG_FILE}: ${where} must be an object`);
  return value;
}

/** Checks a parsed config and fills in the defaults. */
export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new Error(`${CONFIG_FILE} must hold a JSON object`);
  only("", raw, ["remote", "mainBranch", "worktrees", "checks", "status"]);
  const worktrees = section("worktrees", raw.worktrees);
  only("worktrees.", worktrees, ["dir", "branchPrefix", "copy", "copyNewest", "graceHours"]);
  const newest = worktrees.copyNewest ?? [];
  if (!Array.isArray(newest)) throw new Error(`${CONFIG_FILE}: worktrees.copyNewest must be a list`);
  const checks = section("checks", raw.checks);
  only("checks.", checks, ["commands", "budget", "timeoutMinutes"]);
  const commands = checks.commands ?? [];
  if (!Array.isArray(commands)) throw new Error(`${CONFIG_FILE}: checks.commands must be a list`);
  const status = section("status", raw.status);
  only("status.", status, ["liveCommand", "liveField"]);
  const budget = checks.budget === undefined || checks.budget === "auto" ? "auto" : positive("checks.budget", checks.budget, 1);
  if (budget !== "auto" && !Number.isInteger(budget)) throw new Error(`${CONFIG_FILE}: checks.budget must be "auto" or a whole number`);
  const parsed: Config = {
    remote: text("remote", raw.remote, defaults.remote),
    mainBranch: text("mainBranch", raw.mainBranch, defaults.mainBranch),
    worktrees: {
      dir: text("worktrees.dir", worktrees.dir, defaults.worktrees.dir),
      branchPrefix: text("worktrees.branchPrefix", worktrees.branchPrefix, defaults.worktrees.branchPrefix),
      copy: texts("worktrees.copy", worktrees.copy),
      copyNewest: newest.map((item: unknown, index: number) => {
        const where = `worktrees.copyNewest[${index}]`;
        const entry = section(where, item);
        only(`${where}.`, entry, ["path", "marker", "skip"]);
        return { path: required(`${where}.path`, entry.path), marker: required(`${where}.marker`, entry.marker), skip: texts(`${where}.skip`, entry.skip) };
      }),
      graceHours: positive("worktrees.graceHours", worktrees.graceHours, defaults.worktrees.graceHours),
    },
    checks: {
      commands: commands.map((item: unknown, index: number) => {
        const where = `checks.commands[${index}]`;
        const entry = section(where, item);
        only(`${where}.`, entry, ["label", "run", "weight"]);
        const weight = positive(`${where}.weight`, entry.weight, 1);
        if (!Number.isInteger(weight)) throw new Error(`${CONFIG_FILE}: ${where}.weight must be a whole number`);
        return { label: required(`${where}.label`, entry.label), run: required(`${where}.run`, entry.run), weight };
      }),
      budget,
      timeoutMinutes: positive("checks.timeoutMinutes", checks.timeoutMinutes, defaults.checks.timeoutMinutes),
    },
    status: { liveCommand: textOrNull("status.liveCommand", status.liveCommand), liveField: textOrNull("status.liveField", status.liveField) },
  };
  const labels = parsed.checks.commands.map(command => command.label);
  const repeated = labels.find((label, index) => labels.indexOf(label) !== index);
  if (repeated) throw new Error(`${CONFIG_FILE}: two checks are labelled "${repeated}"`);
  return parsed;
}

/** The config of the repository whose main checkout is `main`. A repo without the file gets the defaults. */
export function loadConfig(main: string): Config {
  const path = join(main, CONFIG_FILE);
  if (!existsSync(path)) return parseConfig({});
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}


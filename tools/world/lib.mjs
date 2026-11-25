import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPipelineContext, routeIdFromArgv } from "../lib/pipeline-context.mjs";

export const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(TOOLS_DIR, "../..");

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value, { compact = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  fs.writeFileSync(file, `${text}\n`);
}

export function config(routeIdInput = routeIdFromArgv()) {
  return loadPipelineContext(routeIdInput).worldConfig;
}

export function resolveRoot(relativePath) {
  return path.resolve(ROOT, relativePath);
}

export function ensureCommand(command) {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Required command is not available: ${command}`);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 200,
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stderr || result.stdout || ""}` : "";
    throw new Error(`${command} failed with status ${result.status}${detail}`);
  }
  return options.capture ? result.stdout : "";
}

export function flag(name) {
  return process.argv.includes(name);
}

export function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

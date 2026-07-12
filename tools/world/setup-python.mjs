#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ensureCommand, resolveRoot, run } from "./lib.mjs";

ensureCommand("python3");
const venv = resolveRoot(".venv-world");
const python = path.join(venv, "bin", "python3");
if (!fs.existsSync(python)) {
  console.log("Creating .venv-world...");
  run("python3", ["-m", "venv", venv]);
}
console.log("Installing world-build Python dependencies...");
run(python, ["-m", "pip", "install", "--disable-pip-version-check", "-r", resolveRoot("tools/world/requirements.txt")]);
console.log(`Python environment ready: ${python}`);

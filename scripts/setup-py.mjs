#!/usr/bin/env node
/**
 * Cross-platform Python venv setup for the perception nodes.
 *
 * Replaces the chained-shell setup:voice / setup:gaze scripts so this
 * works the same on macOS / Linux / Windows (just by checking the
 * platform and picking the right venv binary path).
 *
 * Usage: node scripts/setup-py.mjs <node>   (node = voice | gaze)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const node = process.argv[2];
if (!node || !["voice", "gaze"].includes(node)) {
  console.error("usage: setup-py.mjs <voice|gaze>");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const serverDir = join(root, "nodes", node, "server");
if (!existsSync(serverDir)) {
  console.error(`server dir not found: ${serverDir}`);
  process.exit(1);
}

const isWin = process.platform === "win32";
const venv = join(serverDir, ".venv");
const pyBin = isWin ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
const pipBin = isWin ? join(venv, "Scripts", "pip.exe") : join(venv, "bin", "pip");

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: serverDir, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const pythonCmd = process.env.PYTHON ?? (isWin ? "py" : "python3.11");
const pythonArgs = isWin && pythonCmd === "py" ? ["-3.11", "-m", "venv", ".venv"] : ["-m", "venv", ".venv"];

if (!existsSync(venv)) {
  run(pythonCmd, pythonArgs);
}
run(pipBin, ["install", "-U", "pip"]);
run(pipBin, ["install", "-r", "requirements.txt"]);
run(pyBin, ["-m", "app.setup_models"]);
console.log(`✓ ${node} python env ready at ${venv}`);

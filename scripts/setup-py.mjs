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

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: serverDir, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// Prefer 3.11 (upstream default) but fall back to 3.12 when the launcher
// doesn't have 3.11 — every dependency ships 3.12 wheels. PYTHON env
// overrides both.
function windowsVenvArgs() {
  const probe = spawnSync("py", ["-3.11", "-c", "1"], { stdio: "ignore" });
  return probe.status === 0 ? ["-3.11", "-m", "venv", ".venv"] : ["-3.12", "-m", "venv", ".venv"];
}

const pythonCmd = process.env.PYTHON ?? (isWin ? "py" : "python3.11");
const pythonArgs = isWin && pythonCmd === "py" ? windowsVenvArgs() : ["-m", "venv", ".venv"];

if (!existsSync(venv)) {
  run(pythonCmd, pythonArgs);
}
// `python -m pip` (not pip.exe) — on Windows pip refuses to overwrite its
// own running executable, so pip.exe install -U pip always fails there.
run(pyBin, ["-m", "pip", "install", "-U", "pip"]);
run(pyBin, ["-m", "pip", "install", "-r", "requirements.txt"]);
run(pyBin, ["-m", "app.setup_models"]);
console.log(`✓ ${node} python env ready at ${venv}`);

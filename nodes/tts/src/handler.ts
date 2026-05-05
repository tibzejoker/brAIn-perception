import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { BrainService } from "@brain/core";
import type {
  NodeHandler,
  NodeInfo,
  NodeOnSpawn,
  NodeTeardown,
  TextPayload,
  Message,
} from "@brain/sdk";

const execFile = promisify(execFileCb);

type Backend = "say" | "espeak-ng" | "espeak" | "powershell" | "none";

interface Voice {
  name: string;
  language?: string;
  description?: string;
}

interface SpeakOpts {
  voice?: string;
  rate?: number;
}

let backend: Backend = "none";
let voicesCache: Voice[] = [];
let voicesLoaded = false;
let current: ChildProcess | null = null;
let nodeId: string | null = null;
let installHint: string | null = null;

// Best-guess install command per Linux distro family. We don't run it
// — we just surface the right one in the UI so the user can copy-paste.
const LINUX_INSTALL_HINTS: Array<{ pkgMgr: string; cmd: string }> = [
  { pkgMgr: "apt-get", cmd: "sudo apt-get install -y espeak-ng" },
  { pkgMgr: "dnf",     cmd: "sudo dnf install -y espeak-ng" },
  { pkgMgr: "pacman",  cmd: "sudo pacman -S --noconfirm espeak-ng" },
  { pkgMgr: "zypper",  cmd: "sudo zypper install -y espeak-ng" },
  { pkgMgr: "apk",     cmd: "sudo apk add espeak-ng" },
];

function commandExists(bin: string): boolean {
  const r = spawnSync(
    process.platform === "win32" ? "where" : "command",
    process.platform === "win32" ? [bin] : ["-v", bin],
    { stdio: "ignore", shell: process.platform !== "win32" },
  );
  return r.status === 0;
}

function pickInstallHint(): string | null {
  if (process.platform !== "linux") return null;
  for (const { pkgMgr, cmd } of LINUX_INSTALL_HINTS) {
    if (commandExists(pkgMgr)) return cmd;
  }
  // No known package manager — give them the most common one anyway.
  return LINUX_INSTALL_HINTS[0].cmd;
}

async function detectBackend(): Promise<Backend> {
  if (process.platform === "darwin") return "say";
  if (process.platform === "win32") return "powershell";
  for (const bin of ["espeak-ng", "espeak"] as const) {
    try {
      await execFile(bin, ["--version"], { timeout: 2000 });
      return bin;
    } catch { /* not installed */ }
  }
  return "none";
}

export function parseSayVoices(stdout: string): Voice[] {
  // `say -v ?` rows like:
  //   Albert              en_US    # Hello! […]
  //   Audrey (Enhanced)   fr_FR    # Bonjour […]
  //   Eddy (Allemand (Allemagne)) de_DE    # Hallo! […]
  // Variable column widths shrink to a single space when the name is wide,
  // so we anchor on the language tag at the end of the pre-`#` part.
  const out: Voice[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const hashIdx = raw.indexOf("#");
    const before = (hashIdx >= 0 ? raw.slice(0, hashIdx) : raw).trim();
    const description = hashIdx >= 0 ? raw.slice(hashIdx + 1).trim() : undefined;
    if (!before) continue;
    const m = before.match(/^(.*?)\s+([a-zA-Z]{2,3}(?:_[A-Za-z0-9]+)?)$/);
    if (!m) continue;
    out.push({ name: m[1].trim(), language: m[2], description });
  }
  return out;
}

export function parseEspeakVoices(stdout: string): Voice[] {
  // `espeak-ng --voices`:
  //  Pty Language Age/Gender VoiceName       File                 Other Languages
  //   5  en             M   english         gmw/en
  const out: Voice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^\s*Pty\b/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    out.push({ name: cols[3], language: cols[1] });
  }
  return out;
}

export function parsePowershellVoices(stdout: string): Voice[] {
  const out: Voice[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [name, culture] = t.split("|");
    if (name) out.push({ name: name.trim(), language: culture?.trim() });
  }
  return out;
}

async function listVoices(): Promise<Voice[]> {
  if (voicesLoaded) return voicesCache;
  try {
    if (backend === "say") {
      const { stdout } = await execFile("say", ["-v", "?"], { timeout: 5000 });
      voicesCache = parseSayVoices(stdout);
    } else if (backend === "espeak-ng" || backend === "espeak") {
      const { stdout } = await execFile(backend, ["--voices"], { timeout: 5000 });
      voicesCache = parseEspeakVoices(stdout);
    } else if (backend === "powershell") {
      const ps =
        "Add-Type -AssemblyName System.Speech;" +
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
        "$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }";
      const { stdout } = await execFile(
        "powershell",
        ["-NoProfile", "-Command", ps],
        { timeout: 5000 },
      );
      voicesCache = parsePowershellVoices(stdout);
    }
  } catch {
    voicesCache = [];
  }
  voicesLoaded = true;
  return voicesCache;
}

export function buildSpeakArgs(
  text: string,
  opts: SpeakOpts,
  forBackend: Backend = backend,
): { cmd: string; args: string[]; input?: string } {
  const b = forBackend;
  if (b === "say") {
    const args: string[] = [];
    if (opts.voice) args.push("-v", opts.voice);
    if (opts.rate) args.push("-r", String(opts.rate));
    args.push("--", text);
    return { cmd: "say", args };
  }
  if (b === "espeak-ng" || b === "espeak") {
    const args: string[] = [];
    if (opts.voice) args.push("-v", opts.voice);
    if (opts.rate) args.push("-s", String(opts.rate));
    args.push("--", text);
    return { cmd: b, args };
  }
  if (b === "powershell") {
    const ps =
      "Add-Type -AssemblyName System.Speech;" +
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;" +
      (opts.voice ? `$s.SelectVoice('${opts.voice.replace(/'/g, "''")}');` : "") +
      (opts.rate
        ? `$s.Rate = ${Math.max(-10, Math.min(10, Math.round((opts.rate - 200) / 20)))};`
        : "") +
      "$t = [Console]::In.ReadToEnd();" +
      "$s.Speak($t);";
    return { cmd: "powershell", args: ["-NoProfile", "-Command", ps], input: text };
  }
  throw new Error(`tts: no usable backend (platform=${process.platform})`);
}

function speakOnce(
  text: string,
  opts: SpeakOpts,
  signal: AbortSignal,
): Promise<{ exit: number; err?: string }> {
  if (current) {
    try { current.kill("SIGTERM"); } catch { /* ignore */ }
    current = null;
  }
  const { cmd, args, input } = buildSpeakArgs(text, opts);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    current = child;
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
    const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } };
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (current === child) current = null;
      resolve({ exit: code ?? 0, err: stderr.trim() || undefined });
    });
    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      if (current === child) current = null;
      resolve({ exit: 1, err: err.message });
    });
  });
}

function buildReadyPayload(): Record<string, unknown> {
  return {
    state: "ready",
    platform: process.platform,
    backend,
    voices: voicesCache,
    install_hint: backend === "none" ? installHint : null,
  };
}

function publishReady(): void {
  const bus = BrainService.current?.bus;
  if (!bus || !nodeId) return;
  bus.publish({
    from: nodeId,
    topic: "tts.status",
    type: "text",
    criticality: 1,
    payload: { content: backend === "none" ? "no backend" : `ready (${backend})` },
    metadata: buildReadyPayload(),
  });
}

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  nodeId = info.id;
  backend = await detectBackend();
  installHint = pickInstallHint();
  voicesLoaded = false;
  voicesCache = [];
  await listVoices();
  publishReady();
};

function asText(msg: Message): string {
  const p = msg.payload as Partial<TextPayload>;
  return typeof p?.content === "string" ? p.content : "";
}

export const handler: NodeHandler = async (ctx) => {
  nodeId ??= ctx.node.id;
  if (backend === "none") {
    backend = await detectBackend();
    if (installHint === null) installHint = pickInstallHint();
  }

  const overrides = (ctx.node.config_overrides ?? {}) as {
    default_voice?: string;
    default_rate?: number;
  };

  for (const msg of ctx.messages) {
    if (msg.topic === "tts.voices.list") {
      const voices = await listVoices();
      ctx.publish("tts.voices", {
        type: "text",
        criticality: 1,
        payload: { content: JSON.stringify({ backend, voices }) },
        metadata: { backend, voices, platform: process.platform, install_hint: installHint },
      });
      continue;
    }

    if (msg.topic === "tts.cancel") {
      if (current) {
        try { current.kill("SIGTERM"); } catch { /* ignore */ }
        current = null;
      }
      ctx.publish("tts.status", {
        type: "text",
        criticality: 1,
        payload: { content: "cancelled" },
        metadata: { state: "cancelled" },
      });
      continue;
    }

    if (msg.topic !== "tts.speak") continue;

    const text = asText(msg).trim();
    if (!text) continue;

    if (backend === "none") {
      const hint = installHint
        ? `tts: no engine found — install with: ${installHint}`
        : `tts: no engine found for platform ${process.platform}`;
      ctx.log("error", hint);
      ctx.publish("tts.status", {
        type: "text",
        criticality: 3,
        payload: { content: hint },
        metadata: {
          state: "error",
          reason: "no-backend",
          platform: process.platform,
          install_hint: installHint,
        },
      });
      continue;
    }

    const meta = (msg.metadata ?? {}) as { voice?: string; rate?: number };
    const opts: SpeakOpts = {
      voice: typeof meta.voice === "string" ? meta.voice : overrides.default_voice,
      rate: typeof meta.rate === "number" ? meta.rate : overrides.default_rate,
    };

    ctx.publish("tts.status", {
      type: "text",
      criticality: 1,
      payload: { content: "speaking" },
      metadata: { state: "speaking", text, voice: opts.voice ?? null, backend },
    });

    const result = await speakOnce(text, opts, ctx.signal);

    if (result.exit === 0) {
      ctx.publish("tts.status", {
        type: "text",
        criticality: 1,
        payload: { content: "spoken" },
        metadata: { state: "spoken", text, voice: opts.voice ?? null, backend },
      });
    } else {
      ctx.publish("tts.status", {
        type: "text",
        criticality: 3,
        payload: { content: result.err ?? `tts exited ${result.exit}` },
        metadata: { state: "error", exit: result.exit, error: result.err, backend },
      });
    }
  }
};

export const teardown: NodeTeardown = () => {
  if (current) {
    try { current.kill("SIGTERM"); } catch { /* ignore */ }
    current = null;
  }
};

export default handler;

import * as path from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { startChildServer, type ChildServerHandle, BrainService, logger } from "@brain/core";
import type { NodeHandler, NodeInfo, NodeOnSpawn, NodeTeardown } from "@brain/sdk";
import WebSocket from "ws";

const PORT = process.env.VOICE_PORT ?? "8765";
const HOST = process.env.VOICE_HOST ?? "127.0.0.1";
const SERVER_URL = process.env.VOICE_SERVER_URL ?? `http://${HOST}:${PORT}`;
const WS_URL = SERVER_URL.replace(/^http/, "ws") + "/ws/events?session_id=default";
const SERVER_DIR = path.resolve(__dirname, "..", "server");
const VENV_PYTHON = process.platform === "win32"
  ? path.join(SERVER_DIR, ".venv", "Scripts", "python.exe")
  : path.join(SERVER_DIR, ".venv", "bin", "python");
const PYTHON_BIN = process.env.VOICE_PYTHON ?? VENV_PYTHON;

let serverPromise: Promise<ChildServerHandle> | null = null;
let nodeId: string | null = null;
let bridgeWs: WebSocket | null = null;
// Generation token, not a boolean: kill+respawn interleaves (seed re-apply)
// can reset a boolean stop-flag while the old bridge socket is still open,
// leaving two live bridges that each republish every event — transcripts
// then arrive twice on the bus. A loop/socket only lives while the global
// epoch matches the one it was created under.
let bridgeEpoch = 0;

/**
 * First-spawn auto-install: if the Python venv doesn't exist yet, run
 * `setup-py.mjs voice` synchronously before trying to start the
 * server. The setup downloads ~200 MB of STT models so this can take
 * a few minutes — the output is piped to stdout so the user sees
 * pip + model download progress in the brAIn API console.
 */
function ensureSetup(): void {
  // The COMPLETION MARKER, not the python binary, is the "installed"
  // signal: a venv whose pip install died half-way (missing headers,
  // network drop) still has python.exe and would otherwise never retry —
  // the server would crash-loop on missing deps forever.
  // Setup is idempotent: a healthy pre-marker venv re-runs it once
  // (~a minute of already-satisfied pip checks), gains the marker, and
  // never pays again.
  const marker = path.join(SERVER_DIR, ".venv", ".brain-setup-complete");
  if (existsSync(marker)) return;
  // perception-root = nodes/voice/dist/.. → nodes/voice/.. → nodes/.. → root
  const setupScript = path.resolve(__dirname, "..", "..", "..", "scripts", "setup-py.mjs");
  if (!existsSync(setupScript)) {
    throw new Error(`voice: venv missing and setup-py.mjs not found at ${setupScript}`);
  }
  logger.warn({ script: setupScript }, "voice: venv missing — running first-time setup (a few minutes)");
  const result = spawnSync(process.execPath, [setupScript, "voice"], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`voice: setup-py.mjs voice failed (exit ${result.status ?? "?"})`);
  }
  logger.info("voice: venv ready");
}

function ensureServer(): Promise<ChildServerHandle> {
  if (serverPromise) return serverPromise;
  ensureSetup();
  const p = startChildServer({
    name: "voice-server",
    healthUrl: `${SERVER_URL}/api/health`,
    command: PYTHON_BIN,
    args: ["-m", "uvicorn", "app.main:app", "--host", HOST, "--port", PORT],
    cwd: SERVER_DIR,
    env: {
      VOICE_ENGINE: process.env.VOICE_ENGINE ?? "real",
    },
    // Cold load of faster-whisper "medium" + WeSpeaker eres2net runs
    // ~90 s on M1; bump generously so the health-check doesn't kill
    // it. Override via VOICE_STARTUP_TIMEOUT_MS for slower CPUs.
    startupTimeoutMs: Number(process.env.VOICE_STARTUP_TIMEOUT_MS ?? "180000"),
  });
  serverPromise = p;
  p.catch((err: unknown) => {
    if (serverPromise === p) serverPromise = null;
    logger.error({ err }, "voice node: child server start failed");
  });
  return p;
}

/**
 * Bridge the Python server's `/ws/events` stream onto the brAIn bus.
 *
 * - Each finalized SegmentEvent → published as `voice.transcript` (criticality
 *   raised on non-provisional ones so the brain wakes up).
 * - Each SpeakerNewEvent → `voice.speaker.detected`.
 *
 * Runs as a long-lived background loop with reconnect backoff. Stops when
 * the bridge epoch moves on (teardown or a newer spawn superseding it).
 */
function startEventBridge(): void {
  const epoch = ++bridgeEpoch;
  let backoffMs = 500;

  const connect = (): void => {
    if (epoch !== bridgeEpoch) return;
    const bus = BrainService.current?.bus;
    const id = nodeId;
    if (!bus || !id) {
      // Bus or node id not yet ready (race between onSpawn and module init).
      // Retry shortly.
      setTimeout(connect, 200);
      return;
    }
    const ws = new WebSocket(WS_URL);
    bridgeWs = ws;
    ws.on("open", () => {
      backoffMs = 500;
      logger.info({ url: WS_URL }, "voice bridge: connected");
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      if (epoch !== bridgeEpoch) return; // superseded bridge — drop, don't republish
      try {
        const event = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        const type = event.type;
        if (type === "segment") {
          // `provisional` marks an UNCERTAIN SPEAKER MATCH, not unstable
          // text — the server emits each segment exactly once and the text
          // is always final. Dropping provisional segments silenced every
          // utterance whose voiceprint didn't match confidently (typically
          // all of them on replayed media), so the brain heard nothing.
          // Publish everything; the flag travels in metadata for consumers
          // that care about attribution confidence.
          bus.publish({
            from: id,
            topic: "voice.transcript",
            type: "text",
            criticality: 4,
            payload: { content: String(event.text ?? "") },
            metadata: event,
          });
        } else if (type === "speaker_new") {
          bus.publish({
            from: id,
            topic: "voice.speaker.detected",
            type: "text",
            criticality: 2,
            payload: { content: `new speaker: ${String(event.name ?? event.speaker_id)}` },
            metadata: event,
          });
        }
      } catch (err) {
        logger.warn({ err }, "voice bridge: malformed event");
      }
    });
    ws.on("close", () => {
      bridgeWs = null;
      if (epoch !== bridgeEpoch) return;
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 15_000);
    });
    ws.on("error", (err: Error) => {
      logger.debug({ err: err.message }, "voice bridge: ws error (will reconnect)");
    });
  };
  connect();
}

type VoiceControl =
  | { action: "start"; session_id?: string; file?: string }
  | { action: "stop"; session_id?: string }
  | { action: "status" };

type SpeakerRename = { speaker_id: string; name: string };

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  nodeId = info.id;
  await ensureServer();
  startEventBridge();
};

export const handler: NodeHandler = async (ctx) => {
  await ensureServer();
  // Capture node id lazily as well, in case onSpawn raced with the first
  // message. Idempotent.
  nodeId ??= ctx.node.id;

  for (const msg of ctx.messages) {
    const topic = msg.topic;

    if (topic === "voice.control") {
      const ctrl = msg.payload as unknown as VoiceControl;
      // A start carrying a file path drives media-file capture (demo/replay)
      // instead of a plain listening session.
      const fileStart = ctrl.action === "start" && typeof ctrl.file === "string" && ctrl.file.length > 0;
      const res = await fetch(`${SERVER_URL}/api/${fileStart ? "capture/start" : "control"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          fileStart ? { file: ctrl.file, session_id: ctrl.session_id ?? "default" } : ctrl,
        ),
      });
      const body = (await res.json()) as Record<string, unknown>;
      ctx.publish("voice.status", {
        type: "text",
        criticality: 1,
        payload: { content: JSON.stringify(body) },
        metadata: body,
      });
      continue;
    }

    if (topic === "voice.speaker.rename") {
      const { speaker_id, name } = msg.payload as unknown as SpeakerRename;
      await fetch(`${SERVER_URL}/api/profiles/${speaker_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      continue;
    }
  }
};

export const teardown: NodeTeardown = async () => {
  bridgeEpoch++;
  if (bridgeWs) {
    try { bridgeWs.close(); } catch { /* ignore */ }
    bridgeWs = null;
  }
  const p = serverPromise;
  if (!p) return;
  serverPromise = null;
  try {
    const handle = await p;
    await handle.kill("voice node teardown");
  } catch (err) {
    logger.warn({ err }, "voice teardown: child server kill failed");
  }
};

export default handler;

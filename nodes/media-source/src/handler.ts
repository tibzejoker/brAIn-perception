/**
 * media-source — virtual camera + microphone.
 *
 * Fakes live devices at the brAIn level: on `media.play {file}` it warms
 * both perception servers (model load paid up front so the two playbacks
 * start within milliseconds of each other), then starts the voice and
 * gaze file-capture modes on the same video. The rest of the network
 * can't tell the difference from a real webcam + mic.
 *
 * Pure TS — no server of its own; it drives the voice/gaze HTTP APIs.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { BrainService, logger } from "@brain/core";
import type { Message, NodeHandler, NodeInfo, NodeOnSpawn, NodeTeardown } from "@brain/sdk";

const VOICE = process.env.VOICE_SERVER_URL ?? "http://127.0.0.1:8765";
const GAZE = process.env.GAZE_SERVER_URL ?? "http://127.0.0.1:8766";
const POLL_MS = Number(process.env.MEDIA_POLL_INTERVAL_MS ?? "1000");

interface CaptureStatus {
  running?: boolean;
  source?: string;
  file?: string | null;
  ended?: boolean;
}

type MediaState = "idle" | "warming" | "playing" | "ended" | "error";

let nodeId: string | null = null;
let state: MediaState = "idle";
let currentFile: string | null = null;
let currentLoop = false;
let lastError: string | null = null;
// Generation token (NOT a boolean): kill+respawn interleaves would revive
// a boolean-gated poll loop — see the voice bridge / gaze poller history.
let pollEpoch = 0;
let pollTimer: NodeJS.Timeout | null = null;

async function post(url: string, body: unknown, timeoutMs = 20_000): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function getStatus(base: string): Promise<CaptureStatus | null> {
  try {
    const res = await fetch(`${base}/api/capture/status`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    return (await res.json()) as CaptureStatus;
  } catch {
    return null;
  }
}

function publishStatus(voice: CaptureStatus | null = null, gaze: CaptureStatus | null = null): void {
  const bus = BrainService.current?.bus;
  if (!bus || !nodeId) return;
  const payload = {
    state,
    file: currentFile,
    loop: currentLoop,
    error: lastError,
    voice,
    gaze,
  };
  bus.publish({
    from: nodeId,
    topic: "media.status",
    type: "text",
    criticality: 1,
    payload: { content: `media: ${state}${currentFile ? ` (${currentFile})` : ""}` },
    metadata: payload,
  });
}

/** Poll both servers while playing; flip to `ended` when the file ran out. */
function startPolling(): void {
  const epoch = ++pollEpoch;
  const tick = async (): Promise<void> => {
    if (epoch !== pollEpoch) return;
    const [voice, gaze] = await Promise.all([getStatus(VOICE), getStatus(GAZE)]);
    if (epoch !== pollEpoch) return;
    const voiceDone = voice == null || voice.source !== "file" || voice.ended === true || voice.running === false;
    const gazeDone = gaze == null || gaze.source !== "file" || gaze.ended === true;
    if (state === "playing" && voiceDone && gazeDone) {
      state = "ended";
      publishStatus(voice, gaze);
      return; // stop polling — a new play/stop restarts the loop
    }
    publishStatus(voice, gaze);
    pollTimer = setTimeout(() => { void tick(); }, POLL_MS);
  };
  void tick();
}

function stopPolling(): void {
  pollEpoch++;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

async function play(file: string, loop: boolean): Promise<void> {
  stopPolling();
  currentFile = file;
  currentLoop = loop;
  lastError = null;
  state = "warming";
  publishStatus();

  // Model load is the slow, variable part — pay it before starting either
  // playback so speech and gaze stay aligned for the correlator.
  const warm = await Promise.allSettled([
    post(`${VOICE}/api/warmup`, {}, 300_000),
    post(`${GAZE}/api/warmup`, {}, 300_000),
  ]);
  const warmErr = warm.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
  if (warmErr) {
    state = "error";
    lastError = `warmup failed: ${String(warmErr.reason)}`;
    publishStatus();
    return;
  }

  const [v, g] = await Promise.all([
    post(`${VOICE}/api/capture/start`, { file, session_id: "default" }),
    post(`${GAZE}/api/capture/start`, { file, loop, fps: 6 }),
  ]);
  if (!v.ok || !g.ok) {
    state = "error";
    lastError = `capture/start failed (voice ${v.status}, gaze ${g.status}): ${!v.ok ? await v.text() : await g.text()}`;
    publishStatus();
    return;
  }
  state = "playing";
  publishStatus();
  startPolling();
}

const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".mpg", ".mpeg", ".wmv", ".ts"]);

/**
 * List a directory for the UI's file picker — dirs + video files only.
 * Runs on the machine hosting the node, which is by construction the
 * machine whose paths `media.play` needs, so remote-hosted nodes browse
 * the right disk.
 */
async function browse(dir: string, req: string | null): Promise<void> {
  const bus = BrainService.current?.bus;
  if (!bus || !nodeId) return;
  let entries: Array<{ name: string; path: string; kind: "dir" | "file" }> = [];
  let error: string | null = null;
  try {
    const items = await readdir(dir, { withFileTypes: true });
    entries = items
      .filter((e) => !e.name.startsWith("."))
      .filter((e) => e.isDirectory() || VIDEO_EXTS.has(extname(e.name).toLowerCase()))
      .map((e) => ({
        name: e.name,
        path: join(dir, e.name),
        kind: e.isDirectory() ? ("dir" as const) : ("file" as const),
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const parent = dirname(dir);
  bus.publish({
    from: nodeId,
    topic: "media.files",
    type: "text",
    criticality: 1,
    payload: { content: `media: listed ${dir} (${entries.length} entries)` },
    metadata: { req, dir, parent: parent !== dir ? parent : null, entries, error },
  });
}

async function stop(): Promise<void> {
  stopPolling();
  await Promise.allSettled([
    post(`${VOICE}/api/capture/stop`, {}),
    post(`${GAZE}/api/capture/stop`, {}),
  ]);
  state = "idle";
  currentFile = null;
  lastError = null;
  publishStatus();
}

function payloadOf(msg: Message): Record<string, unknown> {
  // Three shapes reach us: direct bus publishes put args in `metadata`;
  // some publishers put them straight in `payload`; the node-call REST
  // endpoint (what the UI uses) wraps the request body as
  // payload.content = JSON.stringify(body).
  const meta = (msg.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.file === "string") return meta;
  const p = msg.payload as unknown as Record<string, unknown>;
  if (typeof p?.file === "string") return p;
  if (typeof p?.content === "string") {
    try {
      const parsed = JSON.parse(p.content) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* not JSON */ }
  }
  return meta;
}

export const onSpawn: NodeOnSpawn = (info: NodeInfo) => {
  nodeId = info.id;
  publishStatus();
  return Promise.resolve();
};

export const handler: NodeHandler = async (ctx) => {
  nodeId ??= ctx.node.id;
  for (const msg of ctx.messages) {
    if (msg.topic === "media.play") {
      const p = payloadOf(msg);
      const file = typeof p.file === "string" ? p.file.trim() : "";
      if (!file) {
        state = "error";
        lastError = "media.play requires {file: absolute path}";
        publishStatus();
        continue;
      }
      await play(file, p.loop === true);
      continue;
    }
    if (msg.topic === "media.stop") {
      await stop();
      continue;
    }
    if (msg.topic === "media.browse") {
      const p = payloadOf(msg);
      const dir = typeof p.dir === "string" && p.dir.trim() ? p.dir.trim() : homedir();
      await browse(dir, typeof p.req === "string" ? p.req : null);
      continue;
    }
    if (msg.topic === "media.status.request") {
      const [voice, gaze] = await Promise.all([getStatus(VOICE), getStatus(GAZE)]);
      publishStatus(voice, gaze);
      continue;
    }
  }
};

export const teardown: NodeTeardown = () => {
  stopPolling();
  nodeId = null;
  state = "idle";
  logger.debug("media-source: teardown");
};

export default handler;

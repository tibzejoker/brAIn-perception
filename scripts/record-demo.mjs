#!/usr/bin/env node
/**
 * Screen-record the perception demo into a shareable mp4, sound included.
 *
 * Films the REAL dashboard: opens the network graph, expands the gaze,
 * voice and chat cards in place (their UIs render inside the graph, the
 * bus edges stay visible), resets the chat, plays the demo video as
 * camera + mic on both Python servers, waits for the brain's reply (and
 * its Kokoro playback when a tts node is live), then muxes the demo
 * video's audio — plus the AI's spoken wav — into the capture at the
 * exact offsets.
 *
 * Prerequisites:
 *   - the brAIn stack is running with the vocal-chat seed applied
 *   - `npm i playwright && npx playwright install chromium` (one-off)
 *   - ffmpeg on PATH
 *
 * Usage:
 *   node scripts/record-demo.mjs [videoPath]
 * Env: API_PORT, VOICE_URL, GAZE_URL, DASHBOARD_URL (default :5173),
 *      DEMO_OUT (output mp4 path)
 */
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const API = `http://localhost:${process.env.API_PORT ?? "3000"}`;
const VOICE = process.env.VOICE_URL ?? "http://localhost:8765";
const GAZE = process.env.GAZE_URL ?? "http://localhost:8766";
const VIDEO = resolve(process.argv[2] ?? resolve(here, "..", "..", "..", "demo_video.mp4"));
const OUT = process.env.DEMO_OUT ?? resolve(here, "..", "..", "..", "brAIn_demo_dashboard.mp4");

const log = (m) => console.log(`[record] ${new Date().toISOString().slice(11, 19)} ${m}`);

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("[record] playwright is not installed. One-off setup:");
  console.error("  npm i playwright && npx playwright install chromium");
  process.exit(1);
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}
async function postJson(url, body, timeoutMs = 20_000) {
  const r = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`POST ${url} → ${r.status} ${await r.text()}`);
  return r.json().catch(() => ({}));
}

// 1. Resolve node ids and stamp them into the scene.
const net = await getJson(`${API}/network`);
const idOf = (type) => net.nodes.find((n) => n.type === type)?.id;
const gazeId = idOf("gaze"), voiceId = idOf("voice"), chatId = idOf("chat");
if (!gazeId || !voiceId || !chatId) {
  throw new Error(`vocal-chat topology not live (gaze=${gazeId} voice=${voiceId} chat=${chatId}) — apply the seed first`);
}
const DASHBOARD = process.env.DASHBOARD_URL ?? "http://localhost:5173";

// 2. Clean slate: stop any running captures; reset the chat thread + brain
// state. Double reset with a settle gap: the first reset can wake the brain
// off residual state and produce a stray reply — the second reset moves the
// chat's cut-line past it so the recording starts on an empty thread.
await postJson(`${VOICE}/api/capture/stop`).catch(() => {});
await fetch(`${GAZE}/api/capture/stop`, { method: "POST" }).catch(() => {});
await postJson(`${API}/node/${chatId}/chat.reset`, { reason: "demo recording" });
await new Promise((r) => setTimeout(r, 10_000));
await postJson(`${API}/node/${chatId}/chat.reset`, { reason: "demo recording (settle)" });
log("captures stopped, chat reset (double)");

// 2b. Warm both model stacks so the two /capture/start calls begin the
// video within milliseconds of each other — a late gaze start desyncs
// speech from the gaze targets the correlator matches them against.
log("warming up voice + gaze models…");
await Promise.all([
  postJson(`${VOICE}/api/warmup`, {}, 300_000),
  postJson(`${GAZE}/api/warmup`, {}, 300_000),
]);
log("models warm");

// 3. Launch browser + start recording.
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: resolve(here, "rec"), size: { width: 1920, height: 1080 } },
});
const page = await context.newPage();
// Screen recording starts with the page — timestamp it so the demo video's
// AUDIO track can be muxed into the capture at the right offset afterwards
// (Playwright records video only, no sound).
const recStartMs = Date.now();
await page.goto(DASHBOARD);
log("dashboard open — waiting for the graph");
await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
await page.waitForTimeout(1500);

// Expand the three cards whose UIs tell the story: gaze (the video +
// gaze arrows), voice (transcript), chat (the reply). In-place expansion
// is the dashboard's own feature — several cards can be open at once,
// with the network graph and its edges staying visible around them.
// Each card is then drag-resized via its NodeResizer handle: the default
// 480x360 shows the embedded UI's header but crops the interesting part
// (the gaze preview, the transcript).
const cardFor = (name) => page.locator(".react-flow__node")
  .filter({ has: page.getByText(name, { exact: true }) }).first();

async function resizeCard(card, dx, dy) {
  const handle = card.locator(".react-flow__resize-control").last();
  const hb = await handle.boundingBox();
  if (!hb) throw new Error("no resize handle");
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + dx, hb.y + hb.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
}

const GROW = { gaze: [420, 330], voice: [320, 60], human: [140, 300] };
for (const name of ["gaze", "voice", "human"]) {
  try {
    const card = cardFor(name);
    await card.locator('[title="Expand UI in place"]').click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    const [dx, dy] = GROW[name];
    await resizeCard(card, dx, dy);
    await page.waitForTimeout(300);
  } catch (e) {
    log(`could not expand/resize "${name}" (${e.message}) — continuing`);
  }
}
// Frame the whole network.
try { await page.locator(".react-flow__controls-fitview").click({ timeout: 3_000 }); } catch { /* controls hidden */ }
log("cards expanded — letting UIs settle");
await page.waitForTimeout(5000);

// 4. Roll the video on both servers.
const t0 = Date.now();
await postJson(`${GAZE}/api/capture/start`, { file: VIDEO, fps: 6 });
await postJson(`${VOICE}/api/capture/start`, { file: VIDEO, session_id: "default" });
const audioOffsetMs = Date.now() - recStartMs;
log(`video rolling on gaze + voice — AUDIO_OFFSET_MS=${audioOffsetMs}`);

// 5. Wait for the brain's reply (timeout 150 s), then for the kokoro
//    playback to finish (tts.status state:"spoken") so the recording
//    covers the full spoken answer; keep a short linger after that.
let replied = false;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const msgs = await getJson(`${API}/network/messages?topic=chat.response`).catch(() => []);
  if (msgs.some((m) => (m.timestamp ?? 0) > t0)) { replied = true; break; }
  await page.waitForTimeout(1500);
}
log(replied ? "chat.response landed — waiting for spoken playback" : "TIMEOUT waiting for chat.response");

// The tts node publishes tts.spoken (wav path + start instant) right
// before playing, and tts.status {state:"spoken"} when done.
let spoken = null;
if (replied) {
  const ttsDeadline = Date.now() + 90_000;
  while (Date.now() < ttsDeadline) {
    const evts = await getJson(`${API}/network/messages?topic=tts.spoken`).catch(() => []);
    spoken = evts.filter((m) => (m.timestamp ?? 0) > t0).pop() ?? null;
    if (spoken) {
      const statuses = await getJson(`${API}/network/messages?topic=tts.status`).catch(() => []);
      if (statuses.some((m) => (m.timestamp ?? 0) > spoken.timestamp && m.metadata?.state === "spoken")) break;
    }
    await page.waitForTimeout(1500);
  }
  log(spoken ? `tts spoke: ${spoken.metadata?.file}` : "no tts.spoken observed (muxing demo audio only)");
}
await page.waitForTimeout(4_000);

// 6. Save the capture, then mux the demo video's audio (and the AI's wav
// when present) at the measured offsets.
const video = page.video();
await context.close();
const capture = await video.path();
await browser.close();
log(`saved: ${capture}`);

const ttsFile = spoken?.metadata?.file;
const ttsOffsetMs = spoken ? Math.max(0, (spoken.metadata?.started_at ?? spoken.timestamp) - recStartMs) : 0;
const inputs = ["-i", capture, "-i", VIDEO];
let filter = `[1:a]adelay=${audioOffsetMs}|${audioOffsetMs}[pod]`;
if (ttsFile) {
  inputs.push("-i", ttsFile);
  filter += `;[2:a]adelay=${ttsOffsetMs}|${ttsOffsetMs}[ai]`
    + `;[pod][ai]amix=inputs=2:duration=longest:normalize=0,apad[a]`;
  log(`muxing demo audio @${audioOffsetMs}ms + AI voice @${ttsOffsetMs}ms`);
} else {
  filter += `;[pod]apad[a]`;
}
execFileSync("ffmpeg", [
  "-y", "-v", "error",
  ...inputs,
  "-filter_complex", filter,
  "-map", "0:v", "-map", "[a]",
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "192k",
  "-shortest", OUT,
], { stdio: "inherit" });
log(`done → ${OUT}`);
if (!replied) process.exit(1);

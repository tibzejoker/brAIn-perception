#!/usr/bin/env node
/**
 * E2E demo: a video file replaces the camera + mic and drives the whole
 * perception → intent → brain → chat loop, hands-free.
 *
 *   video ──► gaze  (frames, faces, gaze lines)  ─┐
 *   audio ──► voice (STT + diarization)           ├─► intent ─► brain (LLM)
 *                                                 ┘        └──► chat.response
 *
 * Prerequisites: the brAIn stack is running (`pnpm start` / `./run` in brAIn/)
 * and `ollama serve` is up with the model from seeds/vocal-chat.yaml pulled.
 *
 * Usage:
 *   node scripts/demo-video.mjs [videoPath]
 *     videoPath   defaults to <workspace>/demo_video.mp4
 *
 * Env: API_PORT (3000), VOICE_URL, GAZE_URL, INTENT_URL,
 *      DEMO_TIMEOUT_S (240) — how long to wait for the AI reply.
 *
 * What it does, in order:
 *   1. applies the vocal-chat seed if no brain node is live,
 *   2. waits for the voice + gaze Python servers (first spawn can install
 *      venvs + download models — be patient),
 *   3. starts video-file capture on both servers (same file, same instant),
 *   4. auto-links voice/gaze profiles into intent "persons" as they appear
 *      (order-of-appearance pairing — good enough for a demo scene),
 *   5. tails intent.detected + waits for the brain's chat.response,
 *   6. exits 0 on AI reply, 1 on timeout. The stack keeps running either
 *      way so you can film the dashboard.
 */
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";

const API = `http://localhost:${process.env.API_PORT ?? "3000"}`;
const VOICE = process.env.VOICE_URL ?? "http://localhost:8765";
const GAZE = process.env.GAZE_URL ?? "http://localhost:8766";
const INTENT = process.env.INTENT_URL ?? "http://localhost:8767";
const TIMEOUT_S = Number(process.env.DEMO_TIMEOUT_S ?? "240");

const repoRoot = resolve(import.meta.dirname, "..");
const videoPath = resolve(process.argv[2] ?? resolve(repoRoot, "..", "..", "demo_video.mp4"));

const log = (msg) => console.log(`[demo-video] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

async function waitFor(label, probe, timeoutS, everyMs = 2_000) {
  const deadline = Date.now() + timeoutS * 1_000;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}

// ── 1. stack + seed ─────────────────────────────────────────────────
const SEED_TYPES = ["voice", "gaze", "intent", "brain", "chat"];

async function ensureSeed() {
  const net = await waitFor("brAIn API", () => getJson(`${API}/network`), 30);
  const live = new Set((net?.nodes ?? []).map((n) => n.type));
  const missing = SEED_TYPES.filter((t) => !live.has(t));
  if (missing.length === 0) {
    log("vocal-chat topology already live — skipping seed.");
    return;
  }
  // merge=true: add what's missing without killing unrelated nodes the
  // user may have running (tts, other demos…).
  log(`applying seed "vocal-chat" (missing: ${missing.join(", ")})…`);
  await postJson(`${API}/network/seeds/vocal-chat/apply?merge=true`);
}

// ── 3. capture start ────────────────────────────────────────────────
async function postJsonSlow(url, body) {
  // Model warmups block until ready — allow minutes, not seconds.
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status} ${await res.text()}`);
  return res.json().catch(() => ({}));
}

async function startCaptures() {
  // Warm both model stacks FIRST: /capture/start loads models before
  // streaming, so without this the slower server (gaze) starts its video
  // seconds after the other — desyncing speech from the gaze targets the
  // correlator matches them against.
  log("warming up voice + gaze models (first time can take a minute)…");
  await Promise.all([
    postJsonSlow(`${VOICE}/api/warmup`, {}),
    postJsonSlow(`${GAZE}/api/warmup`, {}),
  ]);
  log(`starting video capture on both servers: ${basename(videoPath)}`);
  const [voice, gaze] = await Promise.all([
    postJson(`${VOICE}/api/capture/start`, { file: videoPath, session_id: "default" }),
    postJson(`${GAZE}/api/capture/start`, { file: videoPath, fps: 6 }),
  ]);
  if (voice.source !== "file" || gaze.source !== "file") {
    throw new Error(`capture didn't switch to file mode: voice=${voice.source} gaze=${gaze.source}`);
  }
}

// ── 4. auto-link persons ────────────────────────────────────────────
// intent only correlates utterances whose voice profile is linked to a
// person. Pair voice↔gaze profiles by order of appearance: fine for a
// controlled demo scene, and the linkage persists in intent.db for reruns.
// Persons get human names (DEMO_NAMES env, default Alex,Sam) which are
// mirrored onto the auto-named voice/gaze profiles so every UI shows
// "Alex" instead of "Speaker 1" / "Face 2" on camera.
const NAMES = (process.env.DEMO_NAMES ?? "Alex,Sam")
  .split(",").map((s) => s.trim()).filter(Boolean);
const AUTO_NAME = /^(speaker|face)\s*\d+$/i;

async function patchJson(url, body) {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`PATCH ${url} → ${res.status}`);
  return res.json();
}

async function autolinkTick() {
  const [voiceProfiles, gazeProfiles, persons] = await Promise.all([
    getJson(`${VOICE}/api/profiles`).catch(() => []),
    getJson(`${GAZE}/api/profiles`).catch(() => []),
    getJson(`${INTENT}/api/persons`).catch(() => []),
  ]);
  const taken = new Set(persons.map((p) => p.name));
  const nextName = () => {
    const name = NAMES.find((n) => !taken.has(n)) ?? `Speaker ${persons.length + 1}`;
    taken.add(name);
    return name;
  };

  // Upgrade generic auto-names from previous runs ("Speaker 1") to real ones.
  for (const p of persons) {
    if (!AUTO_NAME.test(p.name)) continue;
    const name = NAMES.find((n) => !taken.has(n));
    if (!name) break;
    taken.add(name);
    p.name = name;
    await patchJson(`${INTENT}/api/persons/${encodeURIComponent(p.id)}`, { name });
    log(`renamed person → "${name}"`);
  }

  const linkedVoice = new Set(persons.map((p) => p.voice_profile_id).filter(Boolean));
  const linkedGaze = new Set(persons.map((p) => p.gaze_profile_id).filter(Boolean));
  const freeGaze = gazeProfiles.filter((g) => !linkedGaze.has(g.id));

  for (const v of voiceProfiles) {
    if (linkedVoice.has(v.id)) continue;
    // Faces enroll before voices (a face shows in frame 1; a voice only
    // exists once its first utterance finalizes), so free faces may all
    // be held by gaze-only persons by now. A new voice then ADOPTS one —
    // it's the same human finally being heard — instead of spawning a
    // voice-only duplicate.
    const orphan = persons.find((p) => !p.voice_profile_id && p.gaze_profile_id);
    if (freeGaze.length === 0 && orphan) {
      orphan.voice_profile_id = v.id;
      await patchJson(`${INTENT}/api/persons/${encodeURIComponent(orphan.id)}`, { voice_profile_id: v.id });
      log(`voice ${v.id} adopted by person "${orphan.name}"`);
      continue;
    }
    const gaze = freeGaze.shift();
    const person = await postJson(`${INTENT}/api/persons`, {
      name: nextName(),
      voice_profile_id: v.id,
      gaze_profile_id: gaze?.id ?? null,
    });
    persons.push(person);
    log(`linked person "${person.name}" (voice=${v.id}${gaze ? ` gaze=${gaze.id}` : ""})`);
  }
  // Late-arriving gaze profiles: attach to persons still missing one.
  for (const p of persons) {
    if (p.gaze_profile_id) continue;
    const gaze = freeGaze.shift();
    if (!gaze) break;
    p.gaze_profile_id = gaze.id;
    await patchJson(`${INTENT}/api/persons/${encodeURIComponent(p.id)}`, { gaze_profile_id: gaze.id });
    log(`attached gaze ${gaze.id} to person "${p.name}"`);
  }
  // Faces that never matched a voice (silent participants) still deserve
  // a named person — gaze targets then resolve to "talking to Sam".
  for (const g of freeGaze.splice(0)) {
    const person = await postJson(`${INTENT}/api/persons`, {
      name: nextName(),
      gaze_profile_id: g.id,
    });
    persons.push(person);
    log(`linked person "${person.name}" (gaze=${g.id}, no voice yet)`);
  }

  // Mirror person names onto still-auto-named source profiles so the
  // voice transcript + gaze overlays show human names on camera.
  for (const p of persons) {
    const v = voiceProfiles.find((x) => x.id === p.voice_profile_id);
    if (v && AUTO_NAME.test(v.name) && v.name !== p.name) {
      await patchJson(`${VOICE}/api/profiles/${encodeURIComponent(v.id)}`, { name: p.name }).catch(() => {});
    }
    const g = gazeProfiles.find((x) => x.id === p.gaze_profile_id);
    if (g && AUTO_NAME.test(g.name) && g.name !== p.name) {
      await patchJson(`${GAZE}/api/profiles/${encodeURIComponent(g.id)}`, { name: p.name }).catch(() => {});
    }
  }
}

// ── 5. watch for the AI reply ───────────────────────────────────────
async function latestMessages(topic) {
  const msgs = await getJson(`${API}/network/messages?topic=${encodeURIComponent(topic)}`);
  return Array.isArray(msgs) ? msgs : (msgs?.messages ?? []);
}

async function main() {
  if (!existsSync(videoPath)) {
    console.error(`[demo-video] video not found: ${videoPath}`);
    process.exit(1);
  }

  await ensureSeed();

  log("waiting for voice server (first spawn = venv install + model download)…");
  await waitFor("voice server", () => getJson(`${VOICE}/api/health`), 900);
  log("waiting for gaze server…");
  await waitFor("gaze server", () => getJson(`${GAZE}/api/health`), 900);
  log("waiting for intent server…");
  await waitFor("intent server", () => getJson(`${INTENT}/api/health`), 60);

  let intentCursor = 0;
  for (const it of await getJson(`${INTENT}/api/intents?limit=1`).catch(() => [])) {
    intentCursor = Math.max(intentCursor, it.id ?? 0);
  }

  // Voice/gaze profiles persist across runs — link whatever is already
  // known BEFORE the video starts so the very first utterance correlates.
  // (Cold first runs are covered by the intent node's retro-correlation.)
  await autolinkTick().catch((e) => log(`pre-link: ${e.message}`));

  const captureStartMs = Date.now();
  await startCaptures();
  log(`watching for intents + AI reply (timeout ${TIMEOUT_S}s)…`);

  // Success = an intent.addressed fired for THIS run (someone spoke TO the
  // AI), followed by a chat.response that postdates it. Anything looser
  // mistakes the brain's unrelated chatter for a reply to the video.
  let addressedAtMs = 0;
  const deadline = Date.now() + TIMEOUT_S * 1_000;
  while (Date.now() < deadline) {
    await autolinkTick().catch((e) => log(`autolink: ${e.message}`));

    const intents = await getJson(`${INTENT}/api/intents?since_id=${intentCursor}&limit=50`).catch(() => []);
    for (const it of intents.slice().reverse()) {
      if ((it.id ?? 0) <= intentCursor) continue;
      intentCursor = Math.max(intentCursor, it.id ?? 0);
      log(`intent.detected  ${it.source_name} → ${it.target_kind}: "${it.text}"`);
    }

    if (!addressedAtMs) {
      const addressed = (await latestMessages("intent.addressed").catch(() => []))
        .filter((m) => (m.timestamp ?? 0) > captureStartMs);
      if (addressed.length > 0) {
        const meta = addressed[addressed.length - 1].metadata ?? {};
        const q = meta.question ?? {};
        addressedAtMs = addressed[addressed.length - 1].timestamp ?? Date.now();
        log(`intent.addressed ${q.source_name}: "${q.text}" (+${(meta.context ?? []).length} overheard line(s))`);
      }
    }

    if (addressedAtMs) {
      const replies = (await latestMessages("chat.response").catch(() => []))
        .filter((m) => (m.timestamp ?? 0) > addressedAtMs);
      if (replies.length > 0) {
        const last = replies[replies.length - 1];
        const content = last?.payload?.content ?? JSON.stringify(last);
        console.log("\n──────────────────────────────────────────────────");
        console.log(`🧠 AI replied on chat.response:\n\n${content}`);
        console.log("──────────────────────────────────────────────────\n");
        log("SUCCESS — the video drove voice+gaze → intent(addressed) → brain → chat.");
        log("stack left running: film the dashboard (gaze preview + voice transcript + chat).");
        process.exit(0);
      }
    }
    await sleep(1_500);
  }

  console.error("[demo-video] TIMEOUT — no chat.response observed. Diagnostics:");
  for (const [name, url] of [
    ["voice capture", `${VOICE}/api/capture/status`],
    ["gaze capture", `${GAZE}/api/capture/status`],
    ["persons", `${INTENT}/api/persons`],
    ["intents", `${INTENT}/api/intents?limit=5`],
  ]) {
    try { console.error(`  ${name}: ${JSON.stringify(await getJson(url))}`); }
    catch (e) { console.error(`  ${name}: unreachable (${e.message})`); }
  }
  process.exit(1);
}

main().catch((e) => {
  console.error("[demo-video]", e);
  process.exit(1);
});

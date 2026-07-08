"""REST endpoints for profile CRUD and engine control."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .config import settings
from .local_capture import CaptureError, LocalCapture, list_input_devices
from .models import CaptureStartIn, ControlIn, MergeIn, ProfileIn, ProfilePatch
from .profiles import ProfileStore
from .ws import SessionHub


def build_router(store: ProfileStore, hub: SessionHub, capture: LocalCapture) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["voice"])

    @router.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "active_session": hub.active_session or ""}

    @router.get("/profiles")
    def list_profiles() -> list[dict]:
        return store.list()

    @router.post("/profiles")
    def create_profile(body: ProfileIn) -> dict:
        return store.create(name=body.name, color=body.color)

    @router.patch("/profiles/{profile_id}")
    def patch_profile(profile_id: str, body: ProfilePatch) -> dict:
        result = store.patch(profile_id, body.name, body.color)
        if result is None:
            raise HTTPException(404, "profile not found")
        return result

    @router.delete("/profiles/{profile_id}")
    def delete_profile(profile_id: str) -> dict[str, bool]:
        deleted = store.delete(profile_id)
        if deleted:
            hub.identity.drop_profile(profile_id)
        return {"deleted": deleted}

    @router.delete("/profiles")
    def delete_all_profiles() -> dict[str, int]:
        n = 0
        for p in store.list():
            if store.delete(p["id"]):
                n += 1
        # Blanket reset is safer than drop_profile loops when wiping
        # everything — guarantees the engine doesn't carry any stale
        # id in its label map after the user hits "clear all".
        hub.identity.reset_label_map()
        return {"deleted": n}

    @router.post("/profiles/merge")
    def merge_profiles(body: MergeIn) -> dict:
        result = store.merge(body.source_id, body.target_id)
        if result is None:
            raise HTTPException(404, "target profile not found")
        # Remap in-memory diarization-label → profile entries that the
        # engine uses during live sessions. Without this, segments for the
        # merged-away source keep getting routed to a now-stale id, and the
        # resolver silently creates a brand-new profile on the next tick
        # — the "merged profile reappeared" bug.
        hub.identity.remap_profile(body.source_id, body.target_id)
        return result

    @router.get("/profiles/{profile_id}/voiceprints")
    def list_voiceprints(profile_id: str) -> list[dict]:
        return store.voiceprints_meta_for(profile_id)

    @router.post("/voiceprints/{voiceprint_id}/extract")
    def extract_voiceprint(voiceprint_id: str) -> dict:
        result = store.extract_voiceprint(voiceprint_id)
        if result is None:
            raise HTTPException(404, "voiceprint not found")
        return result

    @router.delete("/voiceprints/{voiceprint_id}")
    def delete_voiceprint(voiceprint_id: str) -> dict[str, bool]:
        return {"deleted": store.delete_voiceprint(voiceprint_id)}

    @router.post("/warmup")
    def warmup() -> dict[str, bool]:
        """Load STT/diarization models without opening a capture session.
        Sync (threadpool) on purpose: the caller awaits readiness so a
        subsequent /capture/start streams immediately — needed when video
        playback must start in sync with another server (gaze)."""
        hub.warmup()
        return {"ready": True}

    @router.post("/control")
    async def control(body: ControlIn) -> dict[str, str]:
        if body.action == "start":
            sid = body.session_id or "default"
            await hub.start_session(sid)
            return {"state": "listening", "session_id": sid}
        if body.action == "stop":
            await hub.stop_session()
            return {"state": "idle"}
        return {"state": "listening" if hub.active_session else "idle",
                "session_id": hub.active_session or ""}

    @router.get("/tuning")
    def get_tuning() -> dict[str, float]:
        if hub.engine is None:
            # No active capture session → no engine instantiated yet.
            # Surface defaults from settings so the dashboard can still
            # render a tuning panel before the user clicks Start.
            return {
                "vad_speech_threshold": 0.5,
                "match_threshold": settings.match_threshold,
                "uncertain_threshold": settings.uncertain_threshold,
                "ema_decay": settings.ema_decay,
                "min_segment_ms": float(settings.min_segment_ms),
            }
        return hub.engine.get_tuning()

    @router.patch("/tuning")
    def patch_tuning(body: dict[str, float]) -> dict[str, float]:
        if hub.engine is None:
            raise HTTPException(409, "voice engine not loaded — start a capture session first")
        return hub.engine.set_tuning(**body)

    @router.get("/language")
    def get_language() -> dict[str, str]:
        if hub.engine is None:
            return {"language": settings.language}
        return {"language": hub.engine.get_language()}

    @router.patch("/language")
    def patch_language(body: dict[str, str]) -> dict[str, str]:
        lang = (body.get("language") or "").strip()
        if not lang:
            raise HTTPException(400, "missing 'language' (e.g. 'fr', 'en', 'es')")
        if hub.engine is None:
            # No active capture yet — cache on settings so the next
            # build_engine() picks it up.
            settings.language = lang
            return {"language": lang}
        return {"language": hub.engine.set_language(lang)}

    @router.get("/capture/devices")
    def capture_devices() -> list[dict]:
        try:
            return list_input_devices()
        except CaptureError as e:
            raise HTTPException(503, str(e)) from e

    @router.get("/capture/status")
    def capture_status() -> dict:
        return capture.status()

    @router.post("/capture/start")
    async def capture_start(body: CaptureStartIn) -> dict:
        try:
            return await capture.start(
                body.device, body.session_id or "default", file=body.file,
                audible=body.audible,
            )
        except CaptureError as e:
            raise HTTPException(503, str(e)) from e

    @router.post("/capture/stop")
    async def capture_stop() -> dict:
        return await capture.stop()

    return router

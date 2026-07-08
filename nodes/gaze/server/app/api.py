"""REST endpoints: profile CRUD + detection."""
from __future__ import annotations

import base64
import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import Response

from .engine import GazeEngine
from .local_capture import CaptureError, LocalCapture, list_input_devices
from .models import DetectBase64In, DetectResponse, MergeIn, ProfileIn, ProfilePatch
from .profiles import ProfileStore
from pydantic import BaseModel

log = logging.getLogger(__name__)


class CaptureStartIn(BaseModel):
    device: int = 0
    fps: float = 6.0
    describe: bool = False
    # Video-file mode: absolute path of a video to play as if it were the
    # camera (demo/replay). When set, `device` is ignored. `loop` rewinds
    # at EOF instead of holding the last frame.
    file: str | None = None
    loop: bool = False


class CaptureDescribeIn(BaseModel):
    enabled: bool


def build_router(
    store: ProfileStore, engine: GazeEngine, capture: LocalCapture,
) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["gaze"])

    @router.get("/health")
    def health() -> dict[str, object]:
        # Models are lazy-loaded on /capture/start, so before the first
        # capture session the gazelle/moondream/iris flags read False.
        # That's expected — the dashboard should call capture/start
        # before relying on those.
        return {
            "status": "ok",
            "models_loaded": engine.models_loaded(),
            "gazelle": engine._gazelle is not None,  # noqa: SLF001
            "moondream": engine._moondream is not None,  # noqa: SLF001
            "iris": engine._iris is not None,  # noqa: SLF001
            "profiles": len(store.list()),
        }

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
        return {"deleted": store.delete(profile_id)}

    @router.delete("/profiles")
    def delete_all_profiles() -> dict[str, int]:
        n = 0
        for p in store.list():
            if store.delete(p["id"]):
                n += 1
        return {"deleted": n}

    @router.post("/profiles/merge")
    def merge_profiles(body: MergeIn) -> dict:
        result = store.merge(body.source_id, body.target_id)
        if result is None:
            raise HTTPException(404, "target profile not found")
        return result

    @router.get("/profiles/{profile_id}/faceprints")
    def list_faceprints(profile_id: str) -> list[dict]:
        return store.faceprints_meta_for(profile_id)

    @router.post("/faceprints/{faceprint_id}/extract")
    def extract_faceprint(faceprint_id: str) -> dict:
        result = store.extract_faceprint(faceprint_id)
        if result is None:
            raise HTTPException(404, "faceprint not found")
        return result

    @router.delete("/faceprints/{faceprint_id}")
    def delete_faceprint(faceprint_id: str) -> dict[str, bool]:
        return {"deleted": store.delete_faceprint(faceprint_id)}

    @router.get("/tuning")
    def get_tuning() -> dict[str, float]:
        return engine.get_tuning()

    @router.patch("/tuning")
    def patch_tuning(body: dict[str, float]) -> dict[str, float]:
        return engine.set_tuning(**body)

    @router.post("/detect", response_model=DetectResponse)
    async def detect_multipart(
        image: UploadFile = File(...),
        remember: bool = True,
        describe: bool = False,
    ) -> DetectResponse:
        data = await image.read()
        if not data:
            raise HTTPException(400, "empty image")
        return engine.analyze(data, remember=remember, describe=describe)

    @router.get("/events")
    def list_events(limit: int = 200, since_id: int | None = None) -> list[dict]:
        return store.list_events(limit=limit, since_id=since_id)

    @router.delete("/events")
    def clear_events() -> dict[str, int]:
        return {"deleted": store.clear_events()}

    @router.post("/detect/base64", response_model=DetectResponse)
    def detect_base64(body: DetectBase64In) -> DetectResponse:
        raw = body.image
        if raw.startswith("data:"):
            _, _, raw = raw.partition(",")
        try:
            data = base64.b64decode(raw, validate=False)
        except Exception as e:
            raise HTTPException(400, f"invalid base64: {e}") from e
        if not data:
            raise HTTPException(400, "empty image")
        return engine.analyze(data, remember=body.remember, describe=body.describe)

    @router.get("/capture/devices")
    def capture_devices() -> list[dict]:
        try:
            return list_input_devices()
        except CaptureError as e:
            raise HTTPException(503, str(e)) from e

    @router.get("/capture/status")
    def capture_status() -> dict:
        return capture.status()

    @router.post("/warmup")
    def warmup() -> dict[str, bool]:
        """Load the ML models without starting a capture. Lets a controller
        that must start several sources in sync (e.g. the same video file
        as camera AND mic) pay the model-load cost up front, so the
        subsequent /capture/start begins streaming immediately."""
        engine.ensure_models_loaded()
        return {"ready": True}

    @router.post("/capture/start")
    def capture_start(body: CaptureStartIn) -> dict:
        # Bring the recognizer / gazelle / iris into RAM before opening
        # the camera so the first frame doesn't race the cold model load.
        # Idempotent — already-loaded models short-circuit. Moondream
        # (~4 GB) is paid only when describe is actually requested.
        engine.ensure_models_loaded()
        if body.describe:
            engine.ensure_moondream_loaded()
        try:
            return capture.start(
                device=body.device, fps=body.fps, describe=body.describe,
                file=body.file, loop=body.loop,
            )
        except CaptureError as e:
            raise HTTPException(503, str(e)) from e

    @router.post("/capture/stop")
    def capture_stop() -> dict:
        result = capture.stop()
        # Free the ML weights so an idle gaze-server doesn't hold
        # ~5 GB on Metal/CUDA. Next /capture/start will reload them.
        engine.unload_models()
        return result

    @router.post("/capture/describe")
    def capture_describe(body: CaptureDescribeIn) -> dict:
        # Load here (request thread) rather than stalling the analysis
        # loop for the multi-GB Moondream load on the next frame.
        if body.enabled:
            engine.ensure_moondream_loaded()
        return capture.set_describe(body.enabled)

    @router.get("/capture/preview.jpg")
    def capture_preview() -> Response:
        jpeg = capture.latest_preview()
        if jpeg is None:
            raise HTTPException(404, "no frame available — start capture first")
        # no-store so browsers refetch every <img> reload.
        return Response(
            content=jpeg, media_type="image/jpeg",
            headers={"Cache-Control": "no-store"},
        )

    @router.get("/capture/latest")
    def capture_latest() -> dict:
        resp = capture.latest_response()
        if resp is None:
            return {"width": 0, "height": 0, "faces": [], "elapsed_ms": {}}
        return resp.model_dump()

    return router

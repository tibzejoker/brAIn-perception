"""Pre-download models required by the gaze server.

Run once (or let main.py's bootstrap do it lazily):
    python -m app.setup_models

Models fetched:
    InsightFace buffalo_l (~300 MB) — downloaded under models_dir by
        FaceAnalysis itself on first `.prepare()` call.
    Moondream 2 safetensors @ 2025-01-09 revision (~3.8 GB) — via HuggingFace
        `snapshot_download` into models_dir (shared HF_HOME).
"""
from __future__ import annotations

import logging
import os
import urllib.request

from .config import settings

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")


def _prepare_recognizer() -> None:
    from insightface.app import FaceAnalysis

    log.info("warming up insightface recognizer %s", settings.recognizer)
    app = FaceAnalysis(
        name=settings.recognizer,
        allowed_modules=["detection", "recognition"],
        root=str(settings.models_dir),
    )
    app.prepare(ctx_id=-1, det_size=(settings.det_size, settings.det_size))
    log.info("insightface cached under %s", settings.models_dir)


def _prepare_moondream() -> None:
    from huggingface_hub import snapshot_download

    os.environ.setdefault("HF_HOME", str(settings.models_dir))
    log.info(
        "downloading moondream2 %s@%s → %s",
        settings.moondream_repo, settings.moondream_revision, settings.models_dir,
    )
    snapshot_download(
        repo_id=settings.moondream_repo,
        revision=settings.moondream_revision,
        cache_dir=str(settings.models_dir),
    )
    log.info("moondream2 cached")


def _prepare_face_landmarker() -> None:
    dest = settings.models_dir / "face_landmarker.task"
    if dest.exists() and dest.stat().st_size > 0:
        log.info("face_landmarker.task already at %s", dest)
        return
    url = (
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
        "face_landmarker/float16/1/face_landmarker.task"
    )
    log.info("downloading MediaPipe FaceLandmarker → %s", dest)
    with urllib.request.urlopen(url, timeout=60) as resp:
        dest.write_bytes(resp.read())
    log.info("face_landmarker cached (%.1f MB)", dest.stat().st_size / 1024 / 1024)


def main() -> None:
    settings.models_dir.mkdir(parents=True, exist_ok=True)
    # Order matters: do the small / fast downloads first so partial
    # setups (e.g. interrupted moondream pull) still leave the cheap
    # bits ready. Each step is independent — a failure in one doesn't
    # skip the others, just logs and moves on.
    steps = [
        ("face_landmarker", _prepare_face_landmarker),  # 3.6 MB, mediapipe
        ("insightface", _prepare_recognizer),           # ~300 MB, buffalo_l
        ("moondream", _prepare_moondream),              # ~3.8 GB, HF snapshot
    ]
    failures: list[str] = []
    for name, fn in steps:
        try:
            fn()
        except Exception as e:
            log.error("%s step failed: %s — continuing", name, e)
            failures.append(name)
    if failures:
        log.warning("setup_models finished with %d failure(s): %s",
                    len(failures), ", ".join(failures))
    else:
        log.info("all models ready in %s", settings.models_dir)


if __name__ == "__main__":
    main()

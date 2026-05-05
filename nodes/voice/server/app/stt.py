"""STT wrappers — pluggable backends behind a single sync interface.

`Stt.transcribe(pcm)` is the only contract callers see. Pick the
backend via `VOICE_STT_BACKEND`:

  - `faster-whisper` — ctranslate2-backed Whisper. CPU (int8) or
                       CUDA (float16). Cross-platform (Mac/Linux/Win).
                       Always available since it's the baseline dep.
  - `mlx`            — Apple Silicon MLX. Same Whisper accuracy,
                       5-15× faster than faster-whisper-CPU on
                       M-series. Requires `pip install mlx-whisper`,
                       only importable on macOS arm64.
  - `auto` (default) — picks `mlx` on Apple Silicon when importable,
                       else `faster-whisper`. On CPU-only machines
                       the model size dominates speed: keep
                       `VOICE_STT_MODEL=medium` for quality, drop to
                       `small` / `base` / `tiny` for speed.

All backends are sync — call from a worker thread. The engine owns
the threading.
"""
from __future__ import annotations

import logging
import os
import platform
import sys
import sysconfig
from pathlib import Path
from typing import Protocol

import numpy as np

log = logging.getLogger(__name__)


class Stt(Protocol):
    def transcribe(self, pcm_int16: np.ndarray, sample_rate: int = 16000) -> str: ...


# === auto-detection ===

def _has_mlx() -> bool:
    """True when running on Apple Silicon AND `mlx_whisper` importable."""
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return False
    try:
        import mlx_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def _has_cuda() -> bool:
    try:
        import ctranslate2  # type: ignore[import-not-found]
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def resolve_backend(requested: str) -> str:
    """Pick a concrete backend name from `auto | mlx | faster-whisper`."""
    if requested == "mlx":
        if not _has_mlx():
            log.warning("VOICE_STT_BACKEND=mlx requested but mlx_whisper not importable "
                        "(need Apple Silicon + `pip install mlx-whisper`); falling back "
                        "to faster-whisper")
            return "faster-whisper"
        return "mlx"
    if requested == "faster-whisper":
        return "faster-whisper"
    # auto — prefer MLX on Apple Silicon, otherwise faster-whisper.
    if _has_mlx():
        log.info("auto-selected mlx-whisper backend (Apple Silicon)")
        return "mlx"
    if _has_cuda():
        log.info("auto-selected faster-whisper backend with CUDA")
    else:
        log.info("auto-selected faster-whisper backend on CPU — consider a smaller "
                 "VOICE_STT_MODEL (small/base/tiny) for higher throughput")
    return "faster-whisper"


# === ctranslate2 / faster-whisper plumbing ===

def _setup_cuda_dlls() -> None:
    """Make pip-installed CUDA libs (nvidia-cudnn-cu12, nvidia-cublas-cu12)
    discoverable by ctranslate2 — see install layout caveats in the
    repo README."""
    site_packages = sysconfig.get_paths().get("purelib")
    if not site_packages:
        return
    nvidia_root = os.path.join(site_packages, "nvidia")
    if not os.path.isdir(nvidia_root):
        return
    for sub in ("cudnn", "cublas"):
        bin_dir = os.path.join(nvidia_root, sub, "bin")
        lib_dir = os.path.join(nvidia_root, sub, "lib")
        if sys.platform == "win32" and os.path.isdir(bin_dir):
            try:
                os.add_dll_directory(bin_dir)
            except (AttributeError, OSError):
                pass
        elif sys.platform.startswith("linux") and os.path.isdir(lib_dir):
            existing = os.environ.get("LD_LIBRARY_PATH", "")
            if lib_dir not in existing.split(os.pathsep):
                os.environ["LD_LIBRARY_PATH"] = (
                    f"{lib_dir}{os.pathsep}{existing}" if existing else lib_dir
                )


_setup_cuda_dlls()


def _resolve_ct2_runtime(device: str, compute_type: str) -> tuple[str, str]:
    """Pick (device, compute_type) for ctranslate2."""
    if device == "auto":
        device = "cuda" if _has_cuda() else "cpu"
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    return device, compute_type


class FasterWhisperStt:
    def __init__(
        self,
        model_size: str = "tiny",
        language: str = "en",
        download_root: Path | None = None,
        compute_type: str = "auto",
        device: str = "auto",
    ) -> None:
        from faster_whisper import WhisperModel  # noqa: WPS433

        resolved_device, resolved_compute = _resolve_ct2_runtime(device, compute_type)
        log.info("loading faster-whisper model=%s device=%s compute=%s lang=%s",
                 model_size, resolved_device, resolved_compute, language)
        self._model = WhisperModel(
            model_size,
            device=resolved_device,
            compute_type=resolved_compute,
            download_root=str(download_root) if download_root else None,
        )
        self._language = language

    def transcribe(self, pcm_int16: np.ndarray, sample_rate: int = 16000) -> str:
        if sample_rate != 16000:
            raise ValueError("faster-whisper pipeline expects 16 kHz input")
        audio = pcm_int16.astype(np.float32) / 32768.0
        segments, _ = self._model.transcribe(
            audio,
            language=self._language,
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()


# === MLX (Apple Silicon) ===

# Whisper short names → mlx-community HuggingFace repos. mlx-whisper
# accepts an HF repo id directly; this map keeps the env-friendly
# "small/medium/large-v3-turbo" names aligned with what users expect
# from faster-whisper.
_MLX_REPO_BY_NAME = {
    "tiny":            "mlx-community/whisper-tiny-mlx",
    "base":            "mlx-community/whisper-base-mlx",
    "small":           "mlx-community/whisper-small-mlx",
    "medium":          "mlx-community/whisper-medium-mlx",
    "large":           "mlx-community/whisper-large-v3-mlx",
    "large-v3":        "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo":  "mlx-community/whisper-large-v3-turbo",
}


class MlxWhisperStt:
    def __init__(
        self,
        model_size: str = "medium",
        language: str = "en",
        download_root: Path | None = None,  # noqa: ARG002 — mlx_whisper uses HF cache
    ) -> None:
        import mlx_whisper  # noqa: WPS433
        self._mlx = mlx_whisper
        self._model = _MLX_REPO_BY_NAME.get(model_size, model_size)
        self._language = language
        log.info("loading mlx-whisper model=%s lang=%s (repo=%s)",
                 model_size, language, self._model)

    def transcribe(self, pcm_int16: np.ndarray, sample_rate: int = 16000) -> str:
        if sample_rate != 16000:
            raise ValueError("mlx-whisper pipeline expects 16 kHz input")
        audio = pcm_int16.astype(np.float32) / 32768.0
        result = self._mlx.transcribe(
            audio,
            path_or_hf_repo=self._model,
            language=self._language,
            condition_on_previous_text=False,
        )
        return (result.get("text") or "").strip()


# === factory ===

def build_stt(
    backend: str,
    model_size: str,
    language: str,
    download_root: Path | None,
) -> Stt:
    chosen = resolve_backend(backend)
    if chosen == "mlx":
        return MlxWhisperStt(
            model_size=model_size,
            language=language,
            download_root=download_root,
        )
    return FasterWhisperStt(
        model_size=model_size,
        language=language,
        download_root=download_root,
    )

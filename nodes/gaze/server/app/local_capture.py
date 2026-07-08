"""Local webcam or video-file capture.

Bypasses the browser/POST `/api/detect/base64` path: opens a webcam (or a
video file — demo/replay mode) directly via OpenCV, runs the engine on every
grabbed frame, and stores the latest result so UI clients can poll it. Lets
the brAIn UI (or any controller) drive the gaze pipeline without a browser
webcam stream.

cv2.VideoCapture is blocking, so the grab loop runs in a daemon thread —
not asyncio. We hold the most recent annotated JPEG + DetectResponse
behind a lock so HTTP handlers can read them without racing the worker.
"""
from __future__ import annotations

import io
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .engine import GazeEngine
    from .models import DetectResponse

log = logging.getLogger(__name__)

DEFAULT_FPS = 6.0
DEFAULT_JPEG_QUALITY = 80
DEFAULT_MAX_DEVICE_PROBE = 5  # try indices 0..N-1 when listing devices
# Annotated frame is considered "fresh" relative to the latest raw within
# this window; outside it, the raw frame is preferred so the preview keeps
# moving even when analysis (e.g. Moondream describe) is slow.
ANNOTATED_FRESHNESS_S = 1.5


class CaptureError(RuntimeError):
    pass


class LocalCapture:
    """Owns the host webcam and feeds frames into the GazeEngine."""

    def __init__(self, engine: "GazeEngine") -> None:
        self._engine = engine
        self._lock = threading.Lock()
        self._stop = threading.Event()
        # Two threads: capture (fast cv2.read loop) and analysis (slow
        # engine.analyze worker). Decoupling them keeps the live preview
        # at FPS rate even when analysis blocks on heavy work like
        # Moondream's describe (multi-second per face).
        self._capture_thread: threading.Thread | None = None
        self._analysis_thread: threading.Thread | None = None
        self._cap = None  # cv2.VideoCapture | None — typed loosely to keep the import lazy
        self._device: int | None = None
        self._file: str | None = None
        self._loop_file = False
        self._ended = False
        self._fps_target = DEFAULT_FPS

        # Two JPEG slots:
        # - raw: updated every cv2.read, always fresh
        # - annotated: updated when engine.analyze + draw finishes, lags
        # The preview endpoint serves the annotated when recent, raw otherwise.
        self._latest_raw_jpeg: bytes | None = None
        self._raw_ts: float = 0.0
        self._latest_annotated_jpeg: bytes | None = None
        self._annotated_ts: float = 0.0
        self._latest_response: "DetectResponse | None" = None

        # Single-slot pending frame for the analysis worker. New captures
        # overwrite older ones — we only ever care about the latest.
        # Carries the capture wall-clock so events are stamped with when
        # the frame was grabbed, not when analysis got around to it.
        self._pending_frame = None  # (frame_bgr, jpeg_bytes, captured_at_iso) | None
        self._pending_event = threading.Event()

        self._frames_processed = 0
        self._frames_dropped = 0
        # Toggleable at runtime — Moondream is heavy (~500-1500 ms/face), so
        # default is off and the UI flips it on demand.
        self._describe = False

    @property
    def is_running(self) -> bool:
        t = self._capture_thread
        return t is not None and t.is_alive()

    def status(self) -> dict:
        return {
            "running": self.is_running,
            "device": self._device,
            "source": "file" if self._file else "device",
            "file": self._file,
            "loop": self._loop_file,
            "ended": self._ended,
            "fps_target": self._fps_target,
            "frames_processed": self._frames_processed,
            "frames_dropped": self._frames_dropped,
            "describe": self._describe,
        }

    def set_describe(self, enabled: bool) -> dict:
        self._describe = bool(enabled)
        log.info("describe %s", "enabled" if self._describe else "disabled")
        return self.status()

    def start(
        self,
        device: int = 0,
        fps: float = DEFAULT_FPS,
        describe: bool = False,
        file: str | None = None,
        loop: bool = False,
    ) -> dict:
        if self.is_running:
            # Same source still capturing → no-op, with a late-flip of the
            # describe toggle. Mirrors the voice server so one media.play
            # hitting both servers keeps them in the same state. Anything
            # else restarts: a different file/device, or a file capture
            # that already ENDED — its thread stays alive to hold the last
            # frame, which used to swallow every replay silently.
            same_source = (
                (file is not None and file == self._file)
                or (file is None and self._file is None and device == self._device)
            )
            if same_source and not self._ended:
                self._describe = bool(describe)
                return self.status()
            self.stop()

        try:
            import cv2
        except ImportError as e:
            raise CaptureError("opencv-python is not installed") from e

        if file:
            # Video-file mode (demo/replay): the file plays paced to its
            # native timestamps, exactly as if it were a live camera.
            if not os.path.isfile(file):
                raise CaptureError(f"video file not found: {file}")
            cap = cv2.VideoCapture(file)
            if not cap.isOpened():
                cap.release()
                raise CaptureError(f"failed to open video file: {file}")
        else:
            cap = cv2.VideoCapture(device)
            if not cap.isOpened():
                cap.release()
                raise CaptureError(f"failed to open webcam at index {device}")
            # Reasonable defaults; the camera may ignore them and pick its own.
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        self._cap = cap
        self._device = None if file else device
        self._file = file or None
        self._loop_file = bool(loop)
        self._ended = False
        self._fps_target = max(0.5, min(30.0, float(fps)))
        self._describe = bool(describe)
        self._stop.clear()
        self._pending_event.clear()
        self._pending_frame = None
        self._frames_processed = 0
        self._frames_dropped = 0
        self._latest_raw_jpeg = None
        self._latest_annotated_jpeg = None
        self._raw_ts = 0.0
        self._annotated_ts = 0.0
        self._latest_response = None

        self._capture_thread = threading.Thread(
            target=self._file_capture_loop if self._file else self._capture_loop,
            name="gaze-capture", daemon=True,
        )
        self._analysis_thread = threading.Thread(
            target=self._analysis_loop, name="gaze-analysis", daemon=True,
        )
        self._capture_thread.start()
        self._analysis_thread.start()
        log.info("local capture started (source=%s, fps=%.1f, describe=%s)",
                 self._file or f"cam {device}", self._fps_target, self._describe)
        return self.status()

    def stop(self) -> dict:
        self._stop.set()
        # Wake the analysis worker so it sees the stop flag on the next loop.
        self._pending_event.set()
        for t in (self._capture_thread, self._analysis_thread):
            if t is not None and t.is_alive():
                t.join(timeout=2.0)
        self._capture_thread = None
        self._analysis_thread = None
        cap = self._cap
        self._cap = None
        if cap is not None:
            try: cap.release()
            except Exception: log.exception("error releasing capture")
        self._device = None
        self._file = None
        self._loop_file = False
        self._ended = False
        log.info("local capture stopped (processed=%d, dropped=%d)",
                 self._frames_processed, self._frames_dropped)
        return self.status()

    def latest_preview(self) -> bytes | None:
        """Return the freshest JPEG: annotated if recent, otherwise raw.

        With describe ON, analysis can take several seconds — past that
        window the annotated frame's bboxes would be drawn on a stale
        scene, so we fall back to the live raw frame.
        """
        now = time.monotonic()
        with self._lock:
            ann = self._latest_annotated_jpeg
            ann_ts = self._annotated_ts
            raw = self._latest_raw_jpeg
        if ann is not None and (now - ann_ts) <= ANNOTATED_FRESHNESS_S:
            return ann
        return raw

    def latest_response(self) -> "DetectResponse | None":
        with self._lock:
            return self._latest_response

    def _capture_loop(self) -> None:
        """Fast loop: grab frames, encode raw JPEG, hand off to analysis."""
        try:
            import cv2
        except ImportError:
            log.exception("opencv unavailable mid-loop — bailing")
            return

        period = 1.0 / self._fps_target
        while not self._stop.is_set():
            t0 = time.monotonic()
            cap = self._cap
            if cap is None:
                break
            ok, frame = cap.read()
            if not ok or frame is None:
                self._frames_dropped += 1
                if self._stop.wait(0.1): break
                continue

            if not self._publish_frame(cv2, frame, handoff=True):
                continue

            elapsed = time.monotonic() - t0
            sleep = period - elapsed
            if sleep > 0 and self._stop.wait(sleep):
                break

    def _publish_frame(self, cv2, frame, handoff: bool) -> bool:  # noqa: ANN001
        """Encode a BGR frame, store it as the latest raw JPEG, and (when
        `handoff` is set) hand it to the analysis worker. Returns False when
        JPEG encoding fails (counted as a drop)."""
        captured_at = datetime.now(timezone.utc).isoformat()
        ok_enc, jpeg = cv2.imencode(
            ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), DEFAULT_JPEG_QUALITY],
        )
        if not ok_enc:
            self._frames_dropped += 1
            return False
        jpeg_bytes = jpeg.tobytes()

        with self._lock:
            self._latest_raw_jpeg = jpeg_bytes
            self._raw_ts = time.monotonic()
            if handoff:
                # Single-slot pending: if the analyzer hasn't picked up the
                # previous frame yet, overwrite — we always want the most
                # recent frame to be analyzed, not a stale one.
                self._pending_frame = (frame.copy(), jpeg_bytes, captured_at)
        if handoff:
            self._pending_event.set()
        return True

    def _file_capture_loop(self) -> None:
        """Video-file variant of the capture loop.

        Frames are paced to the file's own timestamps so the pipeline sees
        the exact real-time cadence a camera would produce. The raw preview
        updates at the file's native FPS; analysis handoff is throttled to
        fps_target like the device path. At EOF the loop either rewinds
        (loop mode) or holds the last frame on screen until stop() — the
        preview keeps serving the final frame instead of going blank.
        """
        try:
            import cv2
        except ImportError:
            log.exception("opencv unavailable mid-loop — bailing")
            return

        cap = self._cap
        if cap is None:
            return
        native_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
        frame_period = 1.0 / native_fps if native_fps > 0 else 1.0 / 25.0
        handoff_period = 1.0 / self._fps_target
        t0 = time.monotonic()
        last_handoff = 0.0
        frame_idx = 0

        while not self._stop.is_set():
            cap = self._cap
            if cap is None:
                break
            ok, frame = cap.read()
            if not ok or frame is None:
                if self._loop_file:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    t0 = time.monotonic()
                    frame_idx = 0
                    continue
                self._ended = True
                log.info("video file ended after %d frames — holding last frame", frame_idx)
                self._stop.wait()
                break
            frame_idx += 1

            # Pace to the container's timestamps; fall back to frame index
            # when the demuxer doesn't report POS_MSEC.
            pos_ms = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0)
            offset_s = pos_ms / 1000.0 if pos_ms > 0 else frame_idx * frame_period
            delay = t0 + offset_s - time.monotonic()
            if delay > 0 and self._stop.wait(delay):
                break

            now = time.monotonic()
            handoff = (now - last_handoff) >= handoff_period
            if self._publish_frame(cv2, frame, handoff=handoff) and handoff:
                last_handoff = now

    def _analysis_loop(self) -> None:
        """Slow loop: take latest pending frame, run engine + draw, store annotated."""
        try:
            import cv2
        except ImportError:
            log.exception("opencv unavailable mid-loop — bailing")
            return

        while not self._stop.is_set():
            # Wait for a frame to be pending. Timeout ensures we re-check
            # the stop flag periodically even when nothing is captured.
            if not self._pending_event.wait(timeout=0.5):
                continue
            self._pending_event.clear()
            if self._stop.is_set():
                break
            with self._lock:
                pending = self._pending_frame
                self._pending_frame = None
            if pending is None:
                continue
            frame, jpeg_bytes, captured_at = pending

            try:
                response = self._engine.analyze(
                    jpeg_bytes, remember=True, describe=self._describe,
                    captured_at=captured_at,
                )
                annotated = _draw_overlays(cv2, frame, response)
                ok_ann, ann_jpeg = cv2.imencode(
                    ".jpg", annotated,
                    [int(cv2.IMWRITE_JPEG_QUALITY), DEFAULT_JPEG_QUALITY],
                )
                with self._lock:
                    if ok_ann:
                        self._latest_annotated_jpeg = ann_jpeg.tobytes()
                        self._annotated_ts = time.monotonic()
                    self._latest_response = response
                self._frames_processed += 1
            except Exception:
                log.exception("frame analysis failed (continuing)")
                self._frames_dropped += 1


def list_input_devices(max_probe: int = DEFAULT_MAX_DEVICE_PROBE) -> list[dict]:
    """Probe indices 0..max_probe-1 with a short open. cv2 doesn't expose
    device names natively, so we just report which indices are openable."""
    try:
        import cv2
    except ImportError as e:
        raise CaptureError("opencv-python is not installed") from e

    devices: list[dict] = []
    for i in range(max_probe):
        cap = cv2.VideoCapture(i)
        opened = cap.isOpened()
        if opened:
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
            devices.append({
                "id": i,
                "name": f"Camera {i}",
                "width": width,
                "height": height,
            })
        cap.release()
    return devices


def _draw_overlays(cv2, frame, response):
    """Draw bboxes + gaze arrows + labels onto a BGR frame in place. Best-effort.

    Returns the annotated frame (same array; cv2 mutates in place but we
    return so callers can chain).
    """
    h, w = frame.shape[:2]
    for face in response.faces:
        bb = face.bbox
        x0, y0 = int(bb.x_min * w), int(bb.y_min * h)
        x1, y1 = int(bb.x_max * w), int(bb.y_max * h)
        color_hex = face.color or "#22d3ee"
        bgr = _hex_to_bgr(color_hex)

        thickness = 3 if face.looking_at_camera else 2
        cv2.rectangle(frame, (x0, y0), (x1, y1), bgr, thickness)

        label = (face.name or f"face {face.face_index}")
        if face.looking_at_camera:
            label = f"{label} ◉"
        elif face.looking_at:
            label = f"{label} → {face.looking_at}"
        cv2.putText(
            frame, label, (x0, max(15, y0 - 6)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.5, bgr, 1, cv2.LINE_AA,
        )

        # Gaze arrow: from eye_center to gaze point.
        if face.eye_center and face.gaze:
            ex, ey = int(face.eye_center.x * w), int(face.eye_center.y * h)
            gx, gy = int(face.gaze.x * w), int(face.gaze.y * h)
            cv2.arrowedLine(frame, (ex, ey), (gx, gy), bgr, 2, tipLength=0.15)
    return frame


def _hex_to_bgr(hex_str: str) -> tuple[int, int, int]:
    s = hex_str.lstrip("#")
    if len(s) != 6:
        return (255, 255, 255)
    try:
        r = int(s[0:2], 16); g = int(s[2:4], 16); b = int(s[4:6], 16)
        return (b, g, r)
    except ValueError:
        return (255, 255, 255)

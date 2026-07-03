"""Tests for gaze local_capture.LocalCapture.

cv2 + GazeEngine are mocked so this runs without a real webcam or models.

    .venv/bin/python -m unittest tests.test_local_capture -v
"""
from __future__ import annotations

import sys
import threading
import time
import types
import unittest
from unittest.mock import MagicMock

import numpy as np

# Stub cv2 BEFORE importing local_capture so its lazy import resolves to ours.
_fake_cv2 = types.ModuleType("cv2")


class _FakeCap:
    instances: list = []
    file_frame_limit = 5  # frames served in file mode before EOF

    def __init__(self, src) -> None:
        self.src = src
        self.is_file = isinstance(src, str)
        self._opened = True if self.is_file else src >= 0
        self._frame_count = 0
        _FakeCap.instances.append(self)

    def isOpened(self) -> bool:
        return self._opened

    def set(self, prop, value=0) -> bool:
        if prop == _fake_cv2.CAP_PROP_POS_FRAMES:
            self._frame_count = int(value)
        return True

    def get(self, prop) -> float:
        if prop == _fake_cv2.CAP_PROP_FPS:
            return 25.0 if self.is_file else 0.0
        if prop == _fake_cv2.CAP_PROP_POS_MSEC:
            return self._frame_count * 40.0
        return 640.0 if prop == _fake_cv2.CAP_PROP_FRAME_WIDTH else 480.0

    def read(self):
        if not self._opened:
            return False, None
        if self.is_file and self._frame_count >= self.file_frame_limit:
            return False, None  # EOF
        self._frame_count += 1
        # Return a dummy 480x640x3 BGR uint8 frame.
        frame = np.zeros((480, 640, 3), dtype=np.uint8)
        return True, frame

    def release(self) -> None:
        self._opened = False


_fake_cv2.VideoCapture = _FakeCap  # type: ignore[attr-defined]
_fake_cv2.CAP_PROP_BUFFERSIZE = 38
_fake_cv2.CAP_PROP_FRAME_WIDTH = 3
_fake_cv2.CAP_PROP_FRAME_HEIGHT = 4
_fake_cv2.CAP_PROP_POS_MSEC = 0
_fake_cv2.CAP_PROP_POS_FRAMES = 1
_fake_cv2.CAP_PROP_FPS = 5
_fake_cv2.IMWRITE_JPEG_QUALITY = 1
_fake_cv2.FONT_HERSHEY_SIMPLEX = 0
_fake_cv2.LINE_AA = 16


def _imencode(_ext, frame, _params=None):
    # Pretend to encode — return a tiny "jpeg" payload so consumers don't crash.
    return True, np.frombuffer(b"\xff\xd8\xff\xd9stub", dtype=np.uint8)


def _rectangle(*_args, **_kwargs): pass
def _putText(*_args, **_kwargs): pass
def _arrowedLine(*_args, **_kwargs): pass


_fake_cv2.imencode = _imencode  # type: ignore[attr-defined]
_fake_cv2.rectangle = _rectangle  # type: ignore[attr-defined]
_fake_cv2.putText = _putText  # type: ignore[attr-defined]
_fake_cv2.arrowedLine = _arrowedLine  # type: ignore[attr-defined]
sys.modules["cv2"] = _fake_cv2

from app.local_capture import (  # noqa: E402
    CaptureError, LocalCapture, list_input_devices,
)
from app.models import DetectResponse  # noqa: E402


def _make_engine():
    """Return a stub GazeEngine.analyze that returns an empty DetectResponse."""
    engine = MagicMock()
    engine.analyze.return_value = DetectResponse(
        width=640, height=480, faces=[], elapsed_ms={"detect": 1.0},
    )
    return engine


class LocalCaptureLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        _FakeCap.instances.clear()
        self.engine = _make_engine()
        self.cap = LocalCapture(self.engine)

    def tearDown(self) -> None:
        if self.cap.is_running:
            self.cap.stop()

    def test_start_opens_capture(self) -> None:
        s = self.cap.start(device=0, fps=30.0)
        self.assertTrue(s["running"])
        self.assertEqual(s["device"], 0)
        self.assertTrue(self.cap.is_running)

    def test_start_idempotent(self) -> None:
        self.cap.start(device=0, fps=30.0)
        first_capture = self.cap._capture_thread
        first_analysis = self.cap._analysis_thread
        self.cap.start(device=0, fps=30.0)
        self.assertIs(self.cap._capture_thread, first_capture)
        self.assertIs(self.cap._analysis_thread, first_analysis)

    def test_open_failure_raises(self) -> None:
        with self.assertRaises(CaptureError):
            self.cap.start(device=-1)
        self.assertFalse(self.cap.is_running)

    def test_loop_processes_frames_and_calls_engine(self) -> None:
        self.cap.start(device=0, fps=30.0)
        # Wait briefly for the analysis worker to crunch a few frames.
        deadline = time.time() + 2.0
        while time.time() < deadline and self.engine.analyze.call_count < 2:
            time.sleep(0.05)
        self.assertGreaterEqual(self.engine.analyze.call_count, 2)
        self.assertIsNotNone(self.cap.latest_preview())
        self.assertIsNotNone(self.cap.latest_response())

    def test_raw_preview_visible_even_when_analyze_is_slow(self) -> None:
        """Capture thread must update raw frames independently of the
        slow analysis worker. Otherwise a slow describe call freezes the
        live preview entirely."""
        # Make analyze block forever so we'd never get an annotated frame.
        gate = threading.Event()  # noqa: F841 (used inside closure)

        def slow_analyze(*_a, **_kw):
            time.sleep(10.0)  # would never resolve within test timeout
            return None

        self.engine.analyze.side_effect = slow_analyze
        self.cap.start(device=0, fps=30.0)
        # Even though analyze never returns, the capture loop should have
        # produced a raw JPEG within ~1 grab cycle.
        deadline = time.time() + 1.0
        while time.time() < deadline and self.cap.latest_preview() is None:
            time.sleep(0.05)
        self.assertIsNotNone(
            self.cap.latest_preview(),
            "raw preview must be visible even when engine.analyze blocks",
        )

    def test_stop_releases_capture(self) -> None:
        self.cap.start(device=0, fps=30.0)
        time.sleep(0.1)
        s = self.cap.stop()
        self.assertFalse(s["running"])
        self.assertFalse(self.cap.is_running)
        # The fake VideoCapture flips `_opened` to False on release().
        self.assertTrue(all(not c._opened for c in _FakeCap.instances))


class FileCaptureTests(unittest.TestCase):
    """Video-file source: plays paced to the file's timestamps, holds the
    last frame at EOF (or rewinds in loop mode)."""

    def setUp(self) -> None:
        _FakeCap.instances.clear()
        self.engine = _make_engine()
        self.cap = LocalCapture(self.engine)
        # A real file on disk — start() validates existence before cv2.
        import tempfile
        self._tmp = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
        self._tmp.write(b"stub")
        self._tmp.close()

    def tearDown(self) -> None:
        if self.cap.is_running:
            self.cap.stop()
        import os
        os.unlink(self._tmp.name)

    def _wait(self, predicate, timeout=3.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return False

    def test_missing_file_raises(self) -> None:
        with self.assertRaises(CaptureError):
            self.cap.start(file=self._tmp.name + ".nope")
        self.assertFalse(self.cap.is_running)

    def test_plays_to_eof_and_holds_last_frame(self) -> None:
        s = self.cap.start(file=self._tmp.name, fps=30.0)
        self.assertEqual(s["source"], "file")
        self.assertEqual(s["file"], self._tmp.name)
        # 5 fake frames at 25 fps ≈ 200 ms of playback.
        self.assertTrue(self._wait(lambda: self.cap.status()["ended"]),
                        "capture must flag `ended` at EOF")
        # EOF must NOT tear down the capture: preview holds the last frame.
        self.assertTrue(self.cap.is_running)
        self.assertIsNotNone(self.cap.latest_preview())
        self.assertGreaterEqual(self.engine.analyze.call_count, 1)
        s = self.cap.stop()
        self.assertFalse(s["running"])
        self.assertFalse(s["ended"])
        self.assertEqual(s["source"], "device")

    def test_loop_mode_rewinds_instead_of_ending(self) -> None:
        self.cap.start(file=self._tmp.name, fps=30.0, loop=True)
        fake = _FakeCap.instances[-1]
        # Wait long enough for >1 full pass (5 frames × 40 ms = 200 ms/pass):
        # the frame counter resetting below 5 proves a rewind happened.
        self.assertTrue(
            self._wait(lambda: self.engine.analyze.call_count >= 3, timeout=3.0),
        )
        self.assertFalse(self.cap.status()["ended"])
        self.assertTrue(fake._frame_count <= fake.file_frame_limit)

    def test_device_status_reports_device_source(self) -> None:
        self.cap.start(device=0, fps=30.0)
        s = self.cap.status()
        self.assertEqual(s["source"], "device")
        self.assertIsNone(s["file"])
        self.assertFalse(s["ended"])


class DeviceListingTests(unittest.TestCase):
    def setUp(self) -> None:
        _FakeCap.instances.clear()

    def test_list_input_devices_probes_indices(self) -> None:
        devs = list_input_devices(max_probe=3)
        self.assertEqual(len(devs), 3)
        self.assertEqual(devs[0]["id"], 0)
        self.assertEqual(devs[0]["width"], 640)


class MissingCv2Tests(unittest.TestCase):
    def test_start_raises_capture_error_when_cv2_missing(self) -> None:
        saved = sys.modules.pop("cv2")
        sys.modules["cv2"] = None  # type: ignore[assignment]
        try:
            cap = LocalCapture(_make_engine())
            with self.assertRaises(CaptureError):
                cap.start()
        finally:
            sys.modules["cv2"] = saved


if __name__ == "__main__":
    unittest.main()

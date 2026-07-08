"""Local microphone or video/audio-file capture.

Bypasses the browser/WS audio path: opens the host microphone directly via
sounddevice — or decodes a media file's audio track (demo/replay mode) —
and feeds int16 PCM frames into the same SessionHub the WS endpoint uses.
Lets the brAIn UI (or any other controller) drive the voice pipeline
without forcing a web frontend to stay open just for getUserMedia.
"""
from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .ws import SessionHub

log = logging.getLogger(__name__)

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCKSIZE = 1024  # ~64 ms at 16 kHz; matches the cadence the WS path was using
QUEUE_MAX = 64    # ~4 s of audio in flight; we drop oldest on overflow
TAIL_SILENCE_S = 2.0  # silence appended after a file ends so VAD finalizes the last utterance


class CaptureError(RuntimeError):
    pass


class LocalCapture:
    """Owns the host audio device and pushes frames into a SessionHub.

    One instance per server. Single active stream at a time — calling start()
    while running is a no-op that returns the current state.
    """

    def __init__(self, hub: "SessionHub") -> None:
        self._hub = hub
        self._stream = None  # sd.InputStream | None — typed loosely so the import stays lazy
        self._device: int | None = None
        self._device_name: str | None = None
        self._file: str | None = None
        self._file_thread: threading.Thread | None = None
        self._file_stop = threading.Event()
        self._audible = False
        # Mirror diagnostics, surfaced in status(): did the speaker stream
        # actually open, and if not, why.
        self._audible_state: str = "off"
        self._ended = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._queue: asyncio.Queue[bytes] | None = None
        self._consumer: asyncio.Task[None] | None = None
        self._dropped_frames = 0

    @property
    def is_running(self) -> bool:
        if self._stream is not None:
            return True
        t = self._file_thread
        return t is not None and t.is_alive()

    def status(self) -> dict[str, object]:
        return {
            "running": self.is_running,
            "device": self._device,
            "device_name": self._device_name,
            "source": "file" if self._file else "device",
            "file": self._file,
            "ended": self._ended,
            "session_id": self._hub.active_session,
            "sample_rate": SAMPLE_RATE,
            "dropped_frames": self._dropped_frames,
            "audible": self._audible,
            "audible_state": self._audible_state,
        }

    async def start(
        self,
        device: int | str | None,
        session_id: str = "default",
        file: str | None = None,
        audible: bool = False,
    ) -> dict[str, object]:
        if file:
            return await self._start_file(file, session_id, audible)
        # Already running on the same device → no-op. Different device (or
        # leftover file capture, even an ended one) → stop first so the
        # user's selection actually takes effect (Windows/Mac sounddevice
        # fall back to the host default if you don't explicitly close the
        # previous stream).
        if self._stream is not None or self._file_thread is not None:
            if self._stream is not None and (device is None or device == self._device):
                return self.status()
            await self._stop_io()

        try:
            import sounddevice as sd
        except ImportError as e:
            raise CaptureError(
                "sounddevice is not installed in this environment. "
                "Install it via `pip install sounddevice` or `pip install -r requirements.txt`."
            ) from e

        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._dropped_frames = 0

        await self._hub.start_session(session_id)

        def _audio_callback(indata, frames, time_info, status) -> None:  # noqa: ANN001
            if status:
                log.warning("sounddevice stream status: %s", status)
            loop = self._loop
            if loop is None or loop.is_closed():
                return
            try:
                loop.call_soon_threadsafe(self._enqueue, bytes(indata))
            except RuntimeError:
                pass  # loop shutting down

        try:
            stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                blocksize=BLOCKSIZE,
                dtype="int16",
                channels=CHANNELS,
                device=device,
                callback=_audio_callback,
            )
            stream.start()
        except Exception as e:
            await self._hub.stop_session()
            self._loop = None
            self._queue = None
            raise CaptureError(f"failed to open audio device: {e}") from e

        self._stream = stream
        self._device, self._device_name = _resolve_device_info(sd, device)
        self._consumer = asyncio.create_task(self._drain())
        log.info("local capture started (device=%s name=%r session=%s)",
                 self._device, self._device_name, session_id)
        return self.status()

    async def _start_file(self, file: str, session_id: str, audible: bool = False) -> dict[str, object]:
        """Play a media file's audio track into the pipeline (demo/replay).

        The file is decoded with PyAV (already present via faster-whisper),
        resampled to the mic format (16 kHz mono int16), and pushed at
        real-time pace so VAD/STT/diarization see exactly what a live mic
        would produce. A short silence tail is appended at EOF so the VAD
        finalizes the last utterance; the session then stays listening
        until stop() is called.
        """
        if self._stream is not None or self._file_thread is not None:
            if file == self._file and self.is_running:
                return self.status()
            await self._stop_io()

        if not os.path.isfile(file):
            raise CaptureError(f"media file not found: {file}")
        try:
            import av
        except ImportError as e:
            raise CaptureError(
                "PyAV is not installed in this environment. "
                "Install it via `pip install av` (ships with faster-whisper)."
            ) from e

        # Open + probe synchronously so a broken/audio-less file fails the
        # HTTP call instead of dying silently inside the reader thread.
        try:
            container = av.open(file)
        except Exception as e:
            raise CaptureError(f"failed to open media file: {e}") from e
        if not container.streams.audio:
            container.close()
            raise CaptureError(f"no audio track in {file}")

        self._loop = asyncio.get_running_loop()
        self._queue = asyncio.Queue(maxsize=QUEUE_MAX)
        self._dropped_frames = 0
        self._file = file
        self._ended = False
        self._audible = audible
        self._file_stop.clear()

        await self._hub.start_session(session_id)
        self._consumer = asyncio.create_task(self._drain())
        self._file_thread = threading.Thread(
            target=self._file_reader, args=(container,), name="voice-file-capture", daemon=True,
        )
        self._file_thread.start()
        log.info("file capture started (file=%s session=%s)", file, session_id)
        return self.status()

    def _file_reader(self, container: object) -> None:
        """Daemon thread: decode → resample → pace → enqueue.

        Pacing is sample-count based: frame N of PCM may only be pushed
        once wall-clock has reached N/SAMPLE_RATE since start. That gives
        the engine the same real-time cadence as sounddevice's callback.
        """
        import av

        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        t0 = time.monotonic()
        sent_samples = 0
        buf = bytearray()
        chunk_bytes = BLOCKSIZE * 2  # int16 mono

        # Audible mode: mirror the exact PCM the pipeline hears to the
        # host's speakers, so a human (or a screen recording) hears the
        # replay. Best-effort — a missing/busy output device degrades to
        # the old silent behavior rather than failing the capture.
        speaker = None
        if self._audible:
            try:
                import sounddevice as sd
                # PortAudio snapshots the device list at first init and never
                # refreshes it: if the default output changed since (aggregate
                # created, screen-recording virtual device, coreaudiod
                # restart…), writes land on a stale device and come out
                # silent. File mode owns no other PortAudio stream in this
                # process, so a re-init here is safe and picks up the CURRENT
                # default output.
                if self._stream is None:
                    sd._terminate()
                    sd._initialize()
                speaker = sd.RawOutputStream(
                    samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                )
                speaker.start()
                self._audible_state = f"open (device={sd.query_devices(kind='output')['name']})"
                log.info("file capture: audible mode — mirroring audio to speakers")
            except Exception as e:  # noqa: BLE001
                self._audible_state = f"open failed: {e}"
                log.warning("file capture: audible mode unavailable (%s) — continuing silent", e)
                speaker = None
        else:
            self._audible_state = "off"

        def push_pcm(data: bytes, flush: bool = False) -> bool:
            """Chunk into BLOCKSIZE frames and enqueue, sleeping to stay
            real-time. Returns False when stop was requested."""
            nonlocal sent_samples
            buf.extend(data)
            while len(buf) >= chunk_bytes or (flush and buf):
                take = min(chunk_bytes, len(buf))
                chunk = bytes(buf[:take])
                del buf[:take]
                delay = t0 + sent_samples / SAMPLE_RATE - time.monotonic()
                if delay > 0 and self._file_stop.wait(delay):
                    return False
                loop = self._loop
                if loop is None or loop.is_closed():
                    return False
                try:
                    loop.call_soon_threadsafe(self._enqueue, chunk)
                except RuntimeError:
                    return False
                if speaker is not None:
                    try:
                        speaker.write(chunk)
                    except Exception as e:  # noqa: BLE001
                        # output device vanished mid-play — keep feeding the pipeline
                        self._audible_state = f"write failed: {e}"
                sent_samples += take // 2
            return True

        try:
            for frame in container.decode(audio=0):  # type: ignore[attr-defined]
                if self._file_stop.is_set():
                    return
                for resampled in _as_frames(resampler.resample(frame)):
                    if not push_pcm(bytes(resampled.to_ndarray().tobytes())):
                        return
            for resampled in _as_frames(resampler.resample(None)):
                if not push_pcm(bytes(resampled.to_ndarray().tobytes())):
                    return
            # Tail silence: the engine's VAD needs post-speech silence to
            # close the final segment — a file that ends mid-sentence would
            # otherwise leave the last utterance unfinalized forever.
            silence = b"\x00" * int(TAIL_SILENCE_S * SAMPLE_RATE) * 2
            push_pcm(silence, flush=True)
            log.info("file capture reached EOF (%.1fs of audio) — session stays listening",
                     sent_samples / SAMPLE_RATE)
        except Exception:
            log.exception("file capture reader crashed")
        finally:
            self._ended = True
            if speaker is not None:
                try:
                    speaker.stop()
                    speaker.close()
                except Exception:  # noqa: BLE001
                    pass
            try:
                container.close()  # type: ignore[attr-defined]
            except Exception:
                pass

    async def _stop_io(self) -> None:
        """Stop the capture I/O (stream / file reader / consumer) but keep
        the hub session and its models loaded. Used by the restart paths
        (replay, device switch): a restart that goes through the full
        stop() pays a ~10s STT/embedder reload inside capture/start —
        AFTER the caller's warmup phase — which desyncs a media replay
        from the gaze side and breaks voice↔gaze correlation."""
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                log.exception("error closing audio stream (continuing)")

        thread, self._file_thread = self._file_thread, None
        if thread is not None:
            self._file_stop.set()
            thread.join(timeout=2.0)
        self._file = None
        self._ended = False

        consumer, self._consumer = self._consumer, None
        if consumer is not None:
            consumer.cancel()
            try:
                await consumer
            except (asyncio.CancelledError, Exception):
                pass

        self._queue = None
        self._loop = None
        self._device = None
        self._device_name = None

    async def stop(self) -> dict[str, object]:
        if self._stream is None and self._file_thread is None:
            return self.status()

        await self._stop_io()
        await self._hub.stop_session()
        log.info("local capture stopped (dropped %d frames during session)", self._dropped_frames)
        return self.status()

    def _enqueue(self, frame: bytes) -> None:
        queue = self._queue
        if queue is None:
            return
        try:
            queue.put_nowait(frame)
        except asyncio.QueueFull:
            # Drop oldest to keep latency bounded — losing 64 ms of audio
            # is preferable to lagging behind real time when the engine
            # stalls (e.g., during model warm-up).
            try:
                queue.get_nowait()
                queue.put_nowait(frame)
                self._dropped_frames += 1
            except asyncio.QueueEmpty:
                pass

    async def _drain(self) -> None:
        queue = self._queue
        if queue is None:
            return
        try:
            while True:
                frame = await queue.get()
                try:
                    await self._hub.push_audio(frame)
                except Exception:
                    log.exception("hub.push_audio failed (continuing)")
        except asyncio.CancelledError:
            pass


def _as_frames(resampled: object) -> list:
    """Normalize AudioResampler.resample() output across PyAV versions:
    older releases return a single frame (or None), newer ones a list."""
    if resampled is None:
        return []
    if isinstance(resampled, list):
        return resampled
    return [resampled]


def _resolve_device_info(sd, device: int | str | None) -> tuple[int | None, str | None]:  # noqa: ANN001
    try:
        if device is None:
            info = sd.query_devices(kind="input")
            return (info.get("index"), info.get("name"))
        info = sd.query_devices(device)
        return (info.get("index"), info.get("name"))
    except Exception:
        return (None, None)


def list_input_devices() -> list[dict[str, object]]:
    try:
        import sounddevice as sd
    except ImportError as e:
        raise CaptureError("sounddevice is not installed") from e

    devices = sd.query_devices()
    out: list[dict[str, object]] = []
    for i, d in enumerate(devices):
        if d.get("max_input_channels", 0) <= 0:
            continue
        out.append({
            "id": i,
            "name": d.get("name"),
            "max_input_channels": d.get("max_input_channels"),
            "default_samplerate": d.get("default_samplerate"),
            "hostapi": d.get("hostapi"),
        })
    return out

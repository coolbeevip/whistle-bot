# SPDX-License-Identifier: Apache-2.0
"""Record camera video and timestamped input events as one published pair."""
import asyncio
import json
import shutil
import time
import uuid
from datetime import datetime, timezone

from media import finalize_mp4
from resolutions import RECORDING_WIDTHS, SIZES

MIN_FREE = 128 * 1024**2


def stamp(browser_ms=None):
    return {"utc": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "pi_boot_us": time.clock_gettime_ns(time.CLOCK_BOOTTIME) // 1000,
            "browser_epoch_ms": browser_ms}


class Recording:
    def __init__(self, camera, directory):
        self.camera = camera
        self.directory = directory
        self.name = None
        self.events = []
        self.lock = asyncio.Lock()
        self.journal = None
        self.phase = "idle"
        self.started = 0

    def add(self, event, when=None, **fields):
        if self.journal and self.phase in ("starting", "recording"):
            entry = {"event": event, **(when or stamp()), **fields}
            self.events.append(entry)
            self.journal.write(json.dumps(entry) + "\n")
            self.journal.flush()

    async def start(self, when, held, width, settings, active_command):
        async with self.lock:
            if type(width) is not int or width not in RECORDING_WIDTHS:
                raise ValueError("Unsupported recording resolution")
            if self.name:
                raise ValueError("Recording already active")
            if shutil.disk_usage(self.directory).free < MIN_FREE:
                raise ValueError("Storage full")
            name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
            self.work = self.directory / ("." + name)
            self.work.mkdir()
            self.journal = (self.work / "events.jsonl").open("x")
            self.name, self.phase = name, "starting"
            self.events = []
            self.video_size = list(SIZES[width])
            self.started = time.monotonic()
            self.add("record_start", when, held=held, settings=settings.copy(),
                     active_command=active_command)
            try:
                await asyncio.to_thread(self.camera.start_video, self.work / (name + ".mp4"), width)
            except Exception:
                self.journal.close()
                self.journal = self.name = None
                self.phase = "idle"
                shutil.rmtree(self.work)
                raise
            self.phase = "recording"

    async def stop(self, when, reason, held):
        async with self.lock:
            if not self.name:
                return
            name = self.name
            self.add("record_stop", when, reason=reason, held=held)
            self.phase = "saving"
            try:
                first = await asyncio.to_thread(self.camera.stop_video)
                error = self.camera.error
                if first is None or not (self.work / (name + ".mp4")).stat().st_size:
                    error = error or "No video frames"
                for event in self.events:
                    event["video_ms"] = (event["pi_boot_us"] - first) / 1000 if first is not None else None
                doc = {"schema": 1, "id": name, "video": name + ".mp4",
                       "video_size": self.video_size, "first_frame_pi_boot_us": first, "error": error, "events": self.events}
                (self.work / (name + ".json")).write_text(json.dumps(doc, indent=2) + "\n")
                self.journal.close()
                if error:
                    raise RuntimeError(error)
                await asyncio.to_thread(finalize_mp4, self.work / (name + ".mp4"))
                (self.work / "events.jsonl").unlink()
                self.work.rename(self.directory / name)
            finally:
                self.journal.close()
                self.journal = self.name = None
                self.phase = "idle"

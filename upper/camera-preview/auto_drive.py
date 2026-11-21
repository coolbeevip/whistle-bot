# SPDX-License-Identifier: Apache-2.0
"""One bounded vision decision per stationary camera frame."""
import asyncio
import base64
import json
import os
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import ClientSession, ClientTimeout, ClientError

CONFIG = Path.home() / ".config/whistle-rover/ai.json"
OWNER = "auto"
RULES = ("Return one JSON object only: {\"action\":\"forward\",\"meters\":0.1}, "
         "{\"action\":\"left\",\"degrees\":15}, {\"action\":\"right\",\"degrees\":15}, "
         "or {\"action\":\"stop\"}. Forward 0.001–0.30 m, turns 1–45 degrees. "
         "Stop if the goal is reached or the next step is unclear or obstructed.")


def configuration(data, previous):
    endpoint = data.get("endpoint", "").strip()
    url = urlsplit(endpoint)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError("Enter a full HTTP endpoint")
    key = data.get("key", "").strip()
    if not key and endpoint == previous.get("endpoint"):
        key = previous.get("key", "")
    return dict(endpoint=endpoint, model=data.get("model", "").strip(), key=key)


def save_config(config):
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=CONFIG.parent, delete=False) as f:
        json.dump(config, f)
    os.replace(f.name, CONFIG)


def decision(data):
    if isinstance(data, dict):
        action = data.get("action")
        if action == "stop" and set(data) == {"action"}:
            return action, None
        if action in ("forward", "left", "right"):
            unit, low, high = ("meters", .001, .30) if action == "forward" else ("degrees", 1, 45)
            value = data.get(unit)
            if set(data) == {"action", unit} and type(value) in (int, float) and low <= value <= high:
                return action, value
    raise ValueError("AI returned an invalid movement")


async def ask(config, camera, instruction, step):
    after = time.clock_gettime_ns(time.CLOCK_BOOTTIME)
    async with asyncio.timeout(8):
        while True:
            jpeg, captured = await asyncio.to_thread(camera.frame, after, 640)
            if captured > after:
                break
            await asyncio.sleep(.04)
    image = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
    chat = urlsplit(config["endpoint"]).path.rstrip("/").endswith("/chat/completions")
    if chat:
        payload = {"messages": [{"role": "system", "content": RULES},
                   {"role": "user", "content": [{"type": "text", "text": instruction},
                    {"type": "image_url", "image_url": {"url": image}}]}]}
    else:
        payload = dict(instruction=instruction, image=image, step=step, rules=RULES)
    if config["model"]:
        payload["model"] = config["model"]
    headers = {"Authorization": "Bearer " + config["key"]} if config["key"] else {}
    async with ClientSession(timeout=ClientTimeout(total=20)) as http:
        async with http.post(config["endpoint"], json=payload, headers=headers, allow_redirects=False) as reply:
            if reply.status != 200:
                raise ValueError(f"AI HTTP {reply.status}")
            raw = bytearray()
            async for chunk in reply.content.iter_chunked(8192):
                raw.extend(chunk)
                if len(raw) > 65536:
                    raise ValueError("AI response too large")
    try:
        result = json.loads(raw)
        if chat:
            result = json.loads(result["choices"][0]["message"]["content"])
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        raise ValueError("Invalid AI response") from exc
    return decision(result)


class AutoDrive:
    def __init__(self, drive, camera, log):
        self.drive, self.camera, self.log = drive, camera, log
        self.config = json.loads(CONFIG.read_text()) if CONFIG.exists() else {}
        self.owner = self.worker = self.task = None
        self.status, self.instruction = "", ""
        self.step = 0
        self.outcome = None
        self.cancelled = False

    def start(self, client, instruction):
        if self.task or self.drive.hold or self.drive.lease:
            raise ValueError("Drive in use")
        if not self.config:
            raise ValueError("Set an AI endpoint in Settings")
        if not self.drive.online or not self.drive.settled:
            raise ValueError("Waiting for chassis to stop")
        if not isinstance(instruction, str) or not 0 < len(instruction.strip()) <= 500:
            raise ValueError("Enter a task (up to 500 characters)")
        self.instruction = instruction.strip()
        self.owner, self.cancelled, self.step = client, False, 0
        self.status = "Starting…"
        self.log("auto_start", instruction=self.instruction)
        self.task = asyncio.create_task(self.supervise())

    def stop(self):
        if self.task:
            self.cancelled = True
            self.status = "Stopping…"
            self.drive.release(OWNER)
            if self.worker and not self.worker.done():
                self.worker.cancel()

    async def stationary(self, since):
        while self.drive.lease or not (self.drive.online and self.drive.settled and self.drive.last_state > since):
            await asyncio.sleep(.05)

    async def loop(self):
        session = self.drive.session
        for step in range(1, 21):
            self.step, self.status = step, "Thinking…"
            if not self.drive.online or not self.drive.settled:
                raise ValueError("Chassis unavailable")
            action, amount = await ask(self.config, self.camera, self.instruction, step)
            if not self.drive.online or not self.drive.settled or self.drive.session != session:
                raise ValueError("Chassis changed during AI request")
            self.log("auto_decision", step=step, action=action, amount=amount)
            if action == "stop":
                return "Completed"
            self.outcome = None
            result = self.drive.start_precision(OWNER, action, amount)
            if result != "requested":
                raise ValueError(result)
            self.status = f"{action.title()} · {amount:g}" + (" m" if action == "forward" else "°")
            while self.outcome is None:
                if not self.drive.online or self.drive.hold != (OWNER, "precision"):
                    raise ValueError("Drive interrupted")
                self.drive.keep(OWNER, "precision")
                await asyncio.sleep(.06)
            if self.outcome != "Completed":
                raise ValueError(self.outcome)
            await self.stationary(time.monotonic())
        return "Step limit reached"

    async def supervise(self):
        result = "Stopped"
        try:
            if not self.cancelled:
                self.worker = asyncio.create_task(self.loop())
                result = await asyncio.wait_for(self.worker, 120)
        except asyncio.CancelledError:
            pass
        except TimeoutError:
            result = "Timed out"
        except ClientError:
            result = "AI connection failed"
        except Exception as exc:
            result = str(exc)[:100] or "Task failed"
        finally:
            self.status = "Stopping…"
            self.drive.release(OWNER)
            await self.stationary(time.monotonic())
            self.status = result
            self.log("auto_end", result=result, step=self.step)
            self.task = self.owner = self.worker = None

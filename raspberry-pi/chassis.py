# SPDX-License-Identifier: Apache-2.0
"""USB link for the ESP32 line-delimited protocol. Only browser holds renew motion."""
import asyncio
import contextlib
import json
import math
import os
import time
import uuid

import serial
from serial.tools import list_ports


DIRECTIONS = {"forward": (1, 1), "reverse": (-1, -1), "left": (-1, 1), "right": (1, -1)}


# Match the ESP32 console's measured counts per revolution and tire diameter.
MM_PER_TICK = math.pi * 67.5 * (1 / 1784 + 1 / 1782) / 2
TURN_MM_S = {"slow": 60, "normal": 100, "fast": 160}
DEFAULTS = {"speed_mm_s": 200, "turn": "normal", "acceleration": "smooth"}


class Chassis:
    def __init__(self, notify):
        self.notify = notify
        self.port = None
        self.session = self.lease = self.window = self.seq = 0
        self.online = False
        self.min_ticks, self.max_ticks = 150, 9000
        self.calibrated = False
        self.manual_max = 0
        self.precision_ops = set()
        self.angle_ready = False
        self.command = None
        self.pending = {}
        self.buffer = bytearray()
        self.hold = None
        self.deadline = 0
        self.last_state = 0
        self.settled = False
        self.wake = asyncio.Event()

    @property
    def speed_limit(self):
        if self.calibrated and self.manual_max > 0:
            return self.manual_max
        return int(self.max_ticks * MM_PER_TICK)

    def motion_command(self, direction, settings):
        left, right = DIRECTIONS[direction]
        speed = (TURN_MM_S[settings["turn"]] if left != right else settings["speed_mm_s"])
        speed = min(speed, self.speed_limit)
        acceleration = settings["acceleration"]
        if self.calibrated:
            return dict(op="drive", left_mm_s=left * speed, right_mm_s=right * speed,
                        acceleration=acceleration)
        ticks = max(self.min_ticks, min(self.max_ticks, round(speed / MM_PER_TICK)))
        return dict(op="drive_low", left_dir=left, right_dir=right, ticks_s=ticks,
                    acceleration=acceleration)

    def press(self, client, direction, settings):
        if self.hold:
            return "busy"
        if not self.online:
            return "offline"
        self.command = self.motion_command(direction, settings)
        self.hold = (client, direction)
        self.deadline = time.monotonic() + .28
        self.wake.set()
        return "requested"

    def start_precision(self, client, direction, amount):
        turn = direction in ("left", "right")
        op = "turn_angle" if turn else "move_distance"
        if direction not in DIRECTIONS or type(amount) not in (int, float) or not (
                (1 if turn else .001) <= amount <= (360 if turn else 3)):
            return "Invalid target"
        if self.hold:
            return "busy"
        if not self.online:
            return "offline"
        if op not in self.precision_ops:
            return "Unsupported firmware"
        if not (self.angle_ready if turn else self.calibrated):
            return "Calibration needed"
        target = amount if turn else amount * 1000
        if direction in ("reverse", "right"):
            target = -target
        self.command = {"op": op, "request_key": uuid.uuid4().hex,
                        ("angle_deg" if turn else "distance_mm"): target}
        self.hold = (client, "precision")
        self.deadline = time.monotonic() + .28
        self.wake.set()
        return "requested"

    async def precision_step(self, target):
        if getattr(self, "acknowledged", None) is not target:
            return await self.call(**self.command)
        key = self.command["request_key"]
        reply = await self.call("heartbeat")
        if reply.get("error") == "STALE_WINDOW":
            return reply
        status = await self.call("status", request_key=key)
        if self.hold is target and status.get("ok") and status.get("action_state") != "running":
            result = status.get("action_state")
            self.notify(target, "Completed" if result == "completed" else
                        "Stopped · " + str(status.get("action_reason", result)))
            self.hold = None
            return {"ok": True}
        return reply if status.get("ok") else status

    def keep(self, client, direction):
        if self.hold == (client, direction) and time.monotonic() < self.deadline:
            self.deadline = time.monotonic() + .28

    def release(self, client):
        if self.hold and self.hold[0] == client:
            self.hold = None
            self.wake.set()

    def read(self):
        try:
            self.buffer.extend(self.port.read(self.port.in_waiting or 1))
            while b"\n" in self.buffer:
                raw, _, self.buffer = self.buffer.partition(b"\n")
                try:
                    msg = json.loads(raw)
                except (ValueError, UnicodeDecodeError):
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("event") == "control_window" and msg["lease"] == self.lease:
                    self.window = msg["window"]
                if "driver_online" in msg:
                    if "manual_max_mm_s" in msg:
                        self.manual_max = int(msg["manual_max_mm_s"])
                        self.calibrated = bool(msg.get("distance_ready")) and self.manual_max > 0
                    self.angle_ready = bool(msg.get("calibrated"))
                    self.settled = bool(msg.get("settled"))
                    self.online = bool(msg["driver_online"])
                    self.last_state = time.monotonic()
                future = self.pending.get(msg.get("id"))
                if future and not future.done():
                    future.set_result(msg)
            if len(self.buffer) > 16384:
                self.buffer.clear()
        except (OSError, serial.SerialException):
            asyncio.get_running_loop().remove_reader(self.port.fileno())
            self.online = False
            for f in self.pending.values():
                if not f.done():
                    f.set_exception(ConnectionError("USB disconnected"))
            self.wake.set()

    async def call(self, op, **fields):
        self.seq += 1
        seq = self.seq
        packet = dict(v=1, id=seq, session=self.session, op=op, **fields)
        if self.lease:
            packet.update(lease=self.lease, window=self.window)
        future = asyncio.get_running_loop().create_future()
        self.pending[seq] = future
        try:
            self.port.write(json.dumps(packet).encode() + b"\n")
            reply = await asyncio.wait_for(future, .45)
        finally:
            self.pending.pop(seq, None)
        return reply

    async def connected(self):
        hello = await self.call("hello")
        self.session = hello["session"]
        if "drive_low" not in hello.get("capabilities", []):
            raise ValueError("Unsupported controller")
        self.precision_ops = set(hello.get("capabilities", []))
        self.min_ticks = int(hello.get("basic_ticks_min", 150))
        self.max_ticks = int(hello.get("basic_ticks_max", 9000))
        active = None
        while True:
            self.wake.clear()
            if self.hold and time.monotonic() >= self.deadline:
                self.notify(self.hold, "hold_timeout")
                self.hold = None
            if self.lease and self.hold is not active:
                await self.call("release")
                self.lease = self.window = 0
                active = None
            if self.hold:
                target = self.hold
                if not self.lease:
                    reply = await self.call("claim")
                    if reply.get("ok"):
                        self.lease, self.window = reply["lease"], reply["window"]
                        active = target
                else:
                    reply = {"ok": True}
                if reply.get("ok") and self.hold is target and time.monotonic() < self.deadline:
                    if target[1] == "precision":
                        reply = await self.precision_step(target)
                    else:
                        reply = await self.call(**self.command)
                    if reply.get("error") == "STALE_WINDOW" and reply.get("lease") == self.lease:
                        self.window = reply["window"]
                        continue
                    if reply.get("ok") and getattr(self, "acknowledged", None) is not target:
                        self.notify(target, "drive_ack")
                        self.acknowledged = target
                if not reply.get("ok"):
                    self.notify(target, reply.get("error", "Drive refused"))
                    if self.hold is target:
                        self.hold = None
                    continue
            elif time.monotonic() - self.last_state > .65:
                reply = await self.call("status")
                if not reply.get("ok"):
                    raise ConnectionError("Controller restarted")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.wake.wait(), .075)

    async def run(self):
        while True:
            try:
                path = os.environ.get("ROVER_SERIAL") or next(
                    (p.device for p in list_ports.comports() if (p.vid, p.pid) == (0x10c4, 0xea60)), None)
                if path:
                    port = serial.Serial(port=None, baudrate=115200, timeout=0, write_timeout=.05, exclusive=True)
                    port.port = path
                    port.dtr = port.rts = False
                    port.open()
                    self.port = port
                    asyncio.get_running_loop().add_reader(port.fileno(), self.read)
                    await self.connected()
            except (OSError, ValueError, KeyError, asyncio.TimeoutError, serial.SerialException):
                pass
            finally:
                if self.port:
                    asyncio.get_running_loop().remove_reader(self.port.fileno())
                    self.port.close()
                if self.hold:
                    self.notify(self.hold, "USB disconnected")
                self.port = self.hold = None
                self.online = self.calibrated = False
                self.buffer.clear()
                self.session = self.lease = self.window = 0
            await asyncio.sleep(1)

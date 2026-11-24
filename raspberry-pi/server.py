# SPDX-License-Identifier: Apache-2.0
"""Local rover console, USB drive bridge, and paired camera/input recordings."""
import asyncio
import json
import logging
import math
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from aiohttp import web, WSMsgType
from auto_drive import AutoDrive, OWNER, ask, configuration, save_config
from recording import MIN_FREE, Recording, stamp
from camera import Camera
from resolutions import SIZES
from chassis import Chassis, DIRECTIONS
from preferences import load_settings, update_setting

ROOT = Path(__file__).parent
VIDEOS = Path(os.environ.get("ROVER_RECORDINGS", Path.home() / "Videos/whistle-rover"))
ID = re.compile(r"\d{8}T\d{6}Z-[a-f0-9]{8}")


camera = Camera()
record = Recording(camera, VIDEOS)
clients = {}
keys = {}


def drive_result(target, result):
    client, direction = target
    record.add("drive_result", client=client, direction=direction, result=result)
    if client == OWNER and result != "drive_ack":
        auto.outcome = result
    if client in clients and result != "drive_ack":
        clients[client]["notice"] = result


drive = Chassis(drive_result)
auto = AutoDrive(drive, camera, record.add)


settings = load_settings()


def lift(client, when, reason):
    direction = keys.pop(client, None)
    if drive.hold == (client, "precision"):
        drive_result(drive.hold, "Stopped")
    drive.release(client)
    if direction:
        record.add("up", when, direction=direction, client=client, reason=reason)


async def message(client, data, when):
    op = data.get("op")
    direction = data.get("direction")
    now = time.monotonic()
    fresh = 0 <= now - float(data.get("ticket", 0)) <= .35
    if op == "auto_start":
        if not fresh:
            raise ValueError("Input expired")
        auto.start(client, data.get("instruction"))
        clients[client]["notice"] = ""
        return
    if op == "auto_stop":
        auto.stop()
        return
    if auto.task and op in ("down", "precision"):
        raise ValueError("Stopping…" if auto.cancelled else "Auto in use")
    if op == "down" and direction in DIRECTIONS and client not in keys:
        keys[client] = direction
        result = drive.press(client, direction, settings) if fresh else "expired"
        clients[client]["notice"] = "" if result == "requested" else result
        record.add("down", when, direction=direction, client=client, dispatch=result, settings=settings.copy(),
                   command=drive.command if result == "requested" else None)
    elif op == "precision":
        result = drive.start_precision(client, direction, data.get("amount")) if fresh else "expired"
        clients[client]["notice"] = "" if result == "requested" else result
        record.add("precision", when, client=client, direction=direction, amount=data.get("amount"),
                   dispatch=result, command=drive.command if result == "requested" else None)
    elif op == "precision_keep" and fresh:
        drive.keep(client, "precision")
    elif op == "precision_stop" and drive.hold == (client, "precision"):
        lift(client, when, "stop")
    elif op == "chassis_setting":
        key, value = data.get("key"), data.get("value")
        key = update_setting(settings, key, value, drive.speed_limit)
        if key is not None:
            record.add("chassis_setting", when, client=client, key=key, value=value)
    elif op == "hold" and fresh:
        drive.keep(client, direction)
    elif op == "up" and keys.get(client) == direction:
        lift(client, when, data.get("reason", "release"))
    elif op in ("record", "finish"):
        task = asyncio.create_task(toggle_recording(client, op, when, dict(keys), data.get("record_width", 1280)))
        recording_tasks.add(task)
        task.add_done_callback(recording_tasks.discard)


recording_tasks = set()


async def toggle_recording(client, op, when, held, width):
    try:
        if op == "record":
            await record.start(when, held, width, settings, drive.command if drive.hold else None)
        else:
            await record.stop(when, "button", held)
    except Exception as exc:
        logging.exception("Recording command failed")
        if client in clients:
            clients[client]["notice"] = str(exc)[:120]


async def socket(request):
    if request.headers.get("Origin") != "http://" + request.host:
        raise web.HTTPForbidden()
    ws = web.WebSocketResponse(max_msg_size=2048, heartbeat=5)
    await ws.prepare(request)
    client = uuid.uuid4().hex[:12]
    clients[client] = {"notice": ""}

    async def send_status():
        while True:
            now = time.monotonic()
            await ws.send_json({"ticket": now, "online": drive.online, "phase": record.phase,
                                "precision_active": drive.hold == (client, "precision"),
                                "auto": {"active": bool(auto.task), "status": auto.status, "step": auto.step,
                                         "instruction": auto.instruction, "configured": bool(auto.config)},
                                "settled": drive.settled, "drive_busy": bool(drive.hold or auto.task),
                                "distance_ready": drive.distance_action_ready and "move_distance" in drive.precision_ops,
                                "angle_ready": drive.angle_ready and "turn_angle" in drive.precision_ops,
                                "settings": settings, "speed_limit_mm_s": drive.speed_limit,
                                "elapsed": int(now - record.started) if record.name else 0,
                                "notice": clients[client]["notice"]})
            await asyncio.sleep(.12)

    sender = asyncio.create_task(send_status())
    try:
        async for packet in ws:
            if packet.type != WSMsgType.TEXT:
                break
            try:
                data = json.loads(packet.data)
                browser = data.get("browser_ms")
                if not isinstance(browser, (float, int)) or not math.isfinite(browser):
                    raise ValueError("Missing timestamp")
                await message(client, data, stamp(browser))
            except Exception as exc:
                clients[client]["notice"] = str(exc)[:120]
    finally:
        if client == auto.owner:
            auto.stop()
        lift(client, stamp(), "disconnect")
        clients.pop(client, None)
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)
    return ws


async def ai_settings(request):
    if request.method == "POST":
        if request.headers.get("Origin") != "http://" + request.host:
            raise web.HTTPForbidden()
        try:
            data = await request.json()
            config = configuration(data, auto.config)
            if request.path.endswith("/test"):
                action, _ = await ask(config, camera, "Connection test. Return stop.", 0)
                return web.json_response({"status": "Connected · " + action})
            if auto.task:
                raise ValueError("Stop Auto before changing settings")
            save_config(config)
            auto.config = config
        except (ValueError, AttributeError) as exc:
            raise web.HTTPBadRequest(text=str(exc)) from exc
        except Exception as exc:
            raise web.HTTPBadGateway(text="AI test failed or timed out") from exc
    return web.json_response({k: auto.config.get(k, "") for k in ("endpoint", "model")},
                             headers={"Cache-Control": "no-store"})


async def frame(request):
    try:
        after = int(request.query.get("after", -1))
        width = int(request.query.get("width", 640))
        if width not in SIZES:
            raise ValueError("Unsupported preview resolution")
        jpeg, number = await asyncio.to_thread(camera.frame, after, width)
        return web.Response(body=jpeg, content_type="image/jpeg",
                            headers={"X-Frame": str(number), "Cache-Control": "no-store"})
    except ValueError:
        raise web.HTTPBadRequest()
    except Exception as exc:
        raise web.HTTPServiceUnavailable(text=str(exc))


async def downloads(request):
    name, ext = request.match_info["name"], request.match_info["ext"]
    if not ID.fullmatch(name) or ext not in ("mp4", "json"):
        raise web.HTTPNotFound()
    file = VIDEOS / name / (name + "." + ext)
    if not file.is_file():
        raise web.HTTPNotFound()
    disposition = "inline" if ext == "mp4" and request.query.get("play") == "1" else "attachment"
    mime = "video/mp4" if ext == "mp4" else "application/json"
    return web.FileResponse(file, headers={"Content-Type": mime,
                            "Content-Disposition": f'{disposition}; filename="{file.name}"'})


async def listing(request):
    names = sorted((p.name for p in VIDEOS.iterdir() if ID.fullmatch(p.name) and p.is_dir()), reverse=True)
    return web.json_response(names, headers={"Cache-Control": "no-store"})


async def delete_recordings(request):
    if request.headers.get("Origin") != "http://" + request.host:
        raise web.HTTPForbidden()
    names = await request.json()
    if not isinstance(names, list) or not names or not all(
        isinstance(name, str) and ID.fullmatch(name) for name in names
    ):
        raise web.HTTPBadRequest(text="Invalid recording selection")
    for name in dict.fromkeys(names):
        folder = VIDEOS / name
        hidden = VIDEOS / (".deleting-" + uuid.uuid4().hex)
        if folder.is_symlink():
            raise web.HTTPBadRequest()
        try:
            folder.rename(hidden)
        except FileNotFoundError:
            continue  # Another client already removed this recording.
        await asyncio.to_thread(shutil.rmtree, hidden)
    return web.Response(status=204)


async def maintenance():
    while True:
        await asyncio.sleep(1)
        if record.phase == "recording" and (camera.error or shutil.disk_usage(VIDEOS).free < MIN_FREE):
            try:
                await record.stop(stamp(), "storage_error", dict(keys))
            except Exception:
                logging.exception("Could not finalize recording")
            for client in clients.values():
                client["notice"] = "Recording stopped: storage error"
        await asyncio.to_thread(camera.idle)


async def lifecycle(app):
    VIDEOS.mkdir(parents=True, exist_ok=True)
    tasks = [asyncio.create_task(drive.run()), asyncio.create_task(maintenance())]
    yield
    auto.stop()
    if auto.task:
        auto.task.cancel()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await asyncio.gather(*recording_tasks, return_exceptions=True)
    try:
        await record.stop(stamp(), "service_stop", dict(keys))
    finally:
        await asyncio.to_thread(camera.idle, True)


async def page(request):
    return web.FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-store"})


app = web.Application()
app.cleanup_ctx.append(lifecycle)
app.add_routes([web.get("/", page), web.static("/static/", ROOT / "static"), web.get("/frame.jpg", frame), web.get("/control", socket),
                web.get("/ai/settings", ai_settings), web.post("/ai/settings", ai_settings), web.post("/ai/test", ai_settings),
                web.get("/recordings", listing), web.post("/recordings/delete", delete_recordings), web.get("/files/{name}.{ext}", downloads)])
if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=8080, access_log=None)

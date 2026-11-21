# SPDX-License-Identifier: Apache-2.0
"""Exercise the service entry point without opening a camera or serial device."""
import importlib
import sys
import tempfile
import time
import types
import unittest
from html.parser import HTMLParser
from unittest.mock import Mock, patch

from aiohttp.test_utils import TestClient, TestServer


class PageAssets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = set()

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == "script" and "src" in attrs:
            self.paths.add(attrs["src"])
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.paths.add(attrs["href"])


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_console_and_observer_session(self):
        camera_module = types.ModuleType("camera")
        camera_module.Camera = Mock
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            "os.environ", {"HOME": directory, "ROVER_RECORDINGS": directory,
                           "ROVER_SERIAL": directory + "/absent"}
        ), patch.dict(sys.modules, {"camera": camera_module}), patch.object(
            time, "CLOCK_BOOTTIME", getattr(time, "CLOCK_BOOTTIME", time.CLOCK_MONOTONIC), create=True
        ):
            service = importlib.import_module("server")
            async with TestClient(TestServer(service.app)) as client:
                response = await client.get("/")
                self.assertEqual(response.status, 200)
                assets = PageAssets()
                assets.feed(await response.text())
                self.assertEqual(assets.paths, {"/static/console.css", "/static/console.js"})
                for path in assets.paths:
                    asset = await client.get(path)
                    self.assertEqual(asset.status, 200)
                    self.assertGreater(len(await asset.read()), 0)
                self.assertEqual(await (await client.get("/recordings")).json(), [])
                url = client.make_url("/control")
                async with client.ws_connect("/control", headers={"Origin": str(url.origin())}) as ws:
                    status = await ws.receive_json(timeout=2)
                    self.assertFalse(status["online"])
                    self.assertEqual(status["phase"], "idle")
                    self.assertIn("settings", status)

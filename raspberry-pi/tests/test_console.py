# SPDX-License-Identifier: Apache-2.0
"""Host regressions for persisted settings and the recording journal."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import preferences
from recording import Recording


class PreferencesTests(unittest.TestCase):
    def test_migrate_and_edit_active_gear(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "chassis.json"
            path.write_text('{"speed_mm_s": 425}')
            with patch.object(preferences, "PREFERENCES", path):
                settings = preferences.load_settings()
                self.assertEqual(settings["gear"], "gear2")
                self.assertEqual(settings["gear2"], 425)
                preferences.update_setting(settings, "speed_mm_s", 450, 800)
                self.assertEqual(preferences.load_settings()["speed_mm_s"], 450)
                with self.assertRaises(ValueError):
                    preferences.update_setting(settings, "gear2", 850, 800)
                self.assertEqual(preferences.load_settings(), settings)


class CameraStub:
    error = None

    def start_video(self, path, width):
        path.write_bytes(b"test video")

    def stop_video(self):
        return 2000


class RecordingTests(unittest.IsolatedAsyncioTestCase):
    async def test_publishes_events_with_original_settings_and_timeline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = Recording(CameraStub(), root)
            settings = {"gear": "gear2"}
            await record.start({"pi_boot_us": 1000}, {}, 640, settings, None)
            name = record.name
            self.assertFalse((root / name).exists())
            settings["gear"] = "gear3"
            with patch("recording.finalize_mp4") as finalize:
                await record.stop({"pi_boot_us": 4000}, "button", {})
                finalize.assert_called_once()
            doc = json.loads((root / name / (name + ".json")).read_text())
            self.assertTrue((root / name / (name + ".mp4")).is_file())
            self.assertEqual(doc["video_size"], [640, 360])
            self.assertEqual(doc["events"][0]["settings"]["gear"], "gear2")
            self.assertEqual([e["video_ms"] for e in doc["events"]], [-1, 2])
            self.assertEqual(record.phase, "idle")

# SPDX-License-Identifier: Apache-2.0
"""Persistent chassis settings, including migration of legacy speed profiles."""
import json
import logging
from pathlib import Path

from chassis import DEFAULTS, TURN_MM_S

PREFERENCES = Path.home() / ".config/whistle-rover/chassis.json"


GEARS = {"gear1": 200, "gear2": 400, "gear3": 600, "gear4": 800}


def validate_setting(key, value):
    valid = (((key == "speed_mm_s" or key in GEARS) and type(value) is int and 1 <= value <= 10000)
             or (key == "gear" and value in GEARS)
             or (key == "turn" and isinstance(value, str) and value in TURN_MM_S)
             or (key == "acceleration" and value in ("smooth", "responsive")))
    if not valid:
        raise ValueError("Invalid chassis setting")


def load_settings():
    settings = {**DEFAULTS, **GEARS, "gear": "gear1"}
    if PREFERENCES.exists():
        try:
            values = json.loads(PREFERENCES.read_text())
            for key, value in values.items():
                validate_setting(key, value)
            if "gear" not in values and "speed_mm_s" in values:
                speed = values["speed_mm_s"]
                gear = min(GEARS, key=lambda name: abs(GEARS[name] - speed))
                values.update({"gear": gear, gear: speed})
            settings.update(values)
            settings["speed_mm_s"] = settings[settings["gear"]]
        except (ValueError, AttributeError, OSError):
            logging.warning("Cannot load chassis preferences")
    return settings


def update_setting(settings, key, value, speed_limit):
    validate_setting(key, value)
    if key == "speed_mm_s":  # Older consoles edit the selected gear.
        key = settings["gear"]
    if key in GEARS and value > speed_limit:
        raise ValueError("Speed exceeds controller limit")
    if settings[key] != value:
        updated = {**settings, key: value}
        updated["speed_mm_s"] = updated[updated["gear"]]
        PREFERENCES.parent.mkdir(parents=True, exist_ok=True)
        tmp = PREFERENCES.with_suffix(".tmp")
        tmp.write_text(json.dumps(updated))
        tmp.replace(PREFERENCES)
        settings.update(updated)
        return key
    return None

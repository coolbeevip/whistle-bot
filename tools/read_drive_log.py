# SPDX-License-Identifier: Apache-2.0
"""Download a completed drive from the ESP32 and summarize its fastest forward segment."""
import argparse
import csv
import io
import json
import time
from pathlib import Path
from statistics import mean

import serial


def analyze(data):
    rows = list(csv.DictReader(line for line in io.StringIO(data) if not line.startswith("#")))
    rows = [{k: int(v) for k, v in row.items()} for row in rows]
    speeds = [r["request_l_ticks_s"] for r in rows
              if 0 < r["request_l_ticks_s"] == r["request_r_ticks_s"]]
    if not speeds:
        return {"samples": len(rows), "result": "No forward straight segment"}
    goal = max(speeds)
    groups, current = [], []
    for r in rows:
        effective = r.get("cruise_limit_ticks_s") or goal
        stable = (r["request_l_ticks_s"] == r["request_r_ticks_s"] == goal
                  and min(r["target_l_ticks_s"], r["target_r_ticks_s"]) >= 0.88 * effective
                  and r["feedback_age_ms"] < 150)
        if stable:
            current.append(r)
        elif current:
            groups.append(current)
            current = []
    groups.append(current)
    group = max(groups, key=len)
    result = {"requested_ticks_s": goal, "samples": len(rows), "cruise_samples": len(group)}
    if len(group) < 7:
        return dict(result, result="Insufficient steady forward driving")
    for side in ("l", "r"):
        result[side] = {
            "target_ticks_s": round(mean(r[f"target_{side}_ticks_s"] for r in group)),
            "measured_ticks_s": round(mean(r[f"measured_{side}_ticks_s"] for r in group)),
            "mean_abs_pwm": round(mean(abs(r[f"pwm_{side}"]) for r in group)),
            "fraction_at_output_limit": round(mean(abs(r[f"pwm_{side}"]) >= r["pwm_limit"] - 2 for r in group), 2),
        }
    millivolts = [r["battery_mv"] for r in group if r["battery_mv"] > 0]
    result["min_battery_mv"] = min(millivolts, default=None)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port")
    parser.add_argument("directory", type=Path)
    parser.add_argument("--run", type=int)
    args = parser.parse_args()
    port = serial.Serial(port=None, baudrate=115200, timeout=0.2)
    port.port = args.port
    port.dtr = port.rts = False
    port.open()
    with port:
        seq, session = 0, 0

        def call(op, **fields):
            nonlocal seq
            seq += 1
            packet = dict(v=1, id=seq, session=session, op=op, **fields)
            port.write(json.dumps(packet).encode() + b"\n")
            until = time.monotonic() + 3
            while time.monotonic() < until:
                try:
                    reply = json.loads(port.readline())
                except (ValueError, UnicodeDecodeError):
                    continue
                if reply.get("id") == seq:
                    if not reply.get("ok"):
                        raise RuntimeError(reply.get("error"))
                    return reply
            raise TimeoutError(op)

        time.sleep(1)
        session = call("hello")["session"]
        index = call("drive_log")
        print(json.dumps(index))
        if index["write_failed"] or index["saving"]:
            raise RuntimeError("Drive log save failed or is still pending")
        run = args.run or index["latest"]
        if not run:
            return
        offset, chunks = 0, []
        while True:
            part = call("drive_log", run=run, offset=offset)
            chunks.append(part["csv"])
            if part["eof"]:
                break
            if part["next"] <= offset:
                raise ValueError("Incomplete log read")
            offset = part["next"]
    data = "".join(chunks)
    args.directory.mkdir(parents=True, exist_ok=True)
    path = args.directory / f"drive-{run}.csv"
    path.write_text(data)
    print(path)
    print(json.dumps(analyze(data), indent=2))


if __name__ == "__main__":
    main()

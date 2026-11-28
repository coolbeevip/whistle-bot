// SPDX-License-Identifier: Apache-2.0
#include "session.h"
#include "../sensors/imu.h"
#include "../storage/drive_log.h"
#include "../transport/network.h"
#include <esp_random.h>

namespace {
String encode(JsonDocument &doc) {
    String out;
    serializeJson(doc, out);
    return out;
}
bool integer(JsonVariantConst v, int lo, int hi) {
    return v.is<int>() && v.as<int>() >= lo && v.as<int>() <= hi;
}
void parameters(JsonObject obj, const Calibration &c) {
    obj["revision"] = c.revision;
    obj["mapped"] = c.mapped;
    obj["left_channel"] = c.left == 0 ? 3 : 4;
    obj["left_mm_tick"] = c.scale[0];
    obj["right_mm_tick"] = c.scale[1];
    obj["checks"] = c.checks;
    obj["left_motor_sign"] = c.motorSign[0];
    obj["right_motor_sign"] = c.motorSign[1];
    obj["left_encoder_sign"] = c.encoderSign[0];
    obj["right_encoder_sign"] = c.encoderSign[1];
    obj["track_mm"] = c.track;
}
const char *controlOwner(const Snapshot &s, uint32_t sid) {
    if (!s.owner) return "free";
    if (s.owner == sid) return "self";
    return (s.owner & 1u) == 0 ? "usb" : "wifi";
}
void describe(JsonDocument &d, const Snapshot &s, uint32_t sid) {
    uint32_t now = millis();
    d["boot_id"] = s.boot;
    describeImu(d);
    if (s.lidar.installed || s.lidar.required) {
        d["lidar_required"] = s.lidar.required;
        d["lidar_valid"] = s.lidar.fresh(now);
    }
    d["battery_valid"] = s.battery.fresh(now);
    if (s.battery.fresh(now)) {
        d["battery_v"] = s.battery.volts;
        d["battery_percent"] = s.battery.percent();
        d["battery_low"] = s.battery.low;
    }
    d["driver_online"] = s.feedback.fresh(now);
    d["settled"] = s.feedback.settled(now) && !s.stopping;
    d["owner"] = controlOwner(s, sid);
    d["manual_max_mm_s"] = s.saved.manualSpeedLimit();
    d["manual_ready"] = s.saved.directionValid();
    d["yaw_ready"] = s.yawReady;
    d["precision_ready"] = s.yawReady && s.saved.distanceReady();
    if (s.action && s.gyroAction) d["action_yaw_deg"] = s.yawProgress;
    if (s.action) {
        d["action_reason"] = s.actionReason;
        d[s.turnAction ? "action_target_deg" : "action_target_mm"] = s.actionTarget;
    }
    d["distance_ready"] = s.saved.distanceReady();
    d["calibrated"] = s.saved.ready();
    d["calibrating"] = s.cal;
    d["reason"] = s.reason;
    d["m3_ticks"] = s.feedback.ticks[0];
    d["m4_ticks"] = s.feedback.ticks[1];
    d["cal_revision"] = s.saved.revision;
    d["action_id"] = s.action;
    d["action_state"] = s.actionState;
    d["feedback_age_ms"] = now - s.feedback.last;
    d["target_left_mm_s"] = s.wheelSpeed[0];
    d["target_right_mm_s"] = s.wheelSpeed[1];
    d["rate_at_ms"] = s.rateAt;
    d["rate_window_ms"] = s.rateInterval;
    d["left_target_ticks_s"] = std::lround(s.referenceTicks[0]);
    d["right_target_ticks_s"] = std::lround(s.referenceTicks[1]);
    d["left_ticks_s"] = std::lround(s.measuredTicks[0]);
    d["right_ticks_s"] = std::lround(s.measuredTicks[1]);
    d["left_pwm"] = s.pwm[0];
    d["right_pwm"] = s.pwm[1];
    if (s.odom.valid && s.feedback.fresh(now)) {
        auto o = d["wheel_odom"].to<JsonObject>();
        o["t_ms"] = s.odom.stamp;
        o["x_mm"] = s.odom.x;
        o["y_mm"] = s.odom.y;
        o["yaw_rad"] = s.odom.heading;
    }
    d["max_wake_us"] = s.maxWakeUs;
    d["max_loop_us"] = s.maxLoopUs;
    d["overruns"] = s.overruns;
    const auto &c = s.cal ? s.draft : s.saved;
    if (c.mapped) {
        d["left_ticks"] = s.feedback.ticks[c.physical(0)] * c.encoderSign[0];
        d["right_ticks"] = s.feedback.ticks[c.physical(1)] * c.encoderSign[1];
    }
    if (s.action) {
        d["left_progress_mm"] = s.goal.actual[0];
        d["right_progress_mm"] = s.goal.actual[1];
        d["left_goal_mm"] = s.goal.target[0];
        d["right_goal_mm"] = s.goal.target[1];
    }
    parameters(d["calibration"].to<JsonObject>(), s.cal && s.owner == sid ? c : s.saved);
    if (s.cal && s.owner == sid)
        parameters(d["saved_calibration"].to<JsonObject>(), s.saved);
}
const char *decode(JsonDocument &d, const String &op, Command &c) {
    if ((op == "drive" || op == "drive_low") && !d["acceleration"].isNull()) {
        if (d["acceleration"] != "smooth" && d["acceleration"] != "responsive") return "RANGE";
        c.responsive = d["acceleration"] == "responsive";
    }
    if (op == "release") {
        c.op = Op::Release;
        for (const char *reason : {"page_hidden", "focus_lost", "heartbeat_failed", "command_failed"})
            if (d["reason"] == reason) c.releaseReason = reason;
    } else if (op == "claim")
        c.op = Op::Claim;
    else if (op == "stop")
        c.op = Op::Stop;
    else if (op == "heartbeat")
        c.op = Op::Beat;
    else if (op == "drive_low") {
        if (!integer(d["left_dir"], -1, 1) || !integer(d["right_dir"], -1, 1))
            return "RANGE";
        if (!d["ticks_s"].isNull()) {
            if (!integer(d["ticks_s"], board::minBasicTicks, board::maxBasicTicks)) return "RANGE";
            c.value = d["ticks_s"].as<int>();
        }
        c.op = Op::DriveLow;
        c.a = d["left_dir"];
        c.b = d["right_dir"];
    } else if (op == "drive_twist") {
        if (!integer(d["linear_mm_s"], -board::maxSpeed, board::maxSpeed) ||
            !integer(d["angular_mrad_s"], -4000, 4000)) return "RANGE";
        c.op = Op::Twist;
        c.a = d["linear_mm_s"];
        c.b = d["angular_mrad_s"];
    } else if (op == "drive") {
        c.op = Op::Drive;
        if (!integer(d["left_mm_s"], -board::maxManualMmPerSecond, board::maxManualMmPerSecond) ||
            !integer(d["right_mm_s"], -board::maxManualMmPerSecond, board::maxManualMmPerSecond))
            return "RANGE";
        c.a = d["left_mm_s"];
        c.b = d["right_mm_s"];
    } else if (op == "cal_begin")
        c.op = Op::CalBegin;
    else if (op == "cal_cancel")
        c.op = Op::CalCancel;
    else if (op == "cal_checkpoint")
        c.op = Op::CalCheckpoint;
    else if (op == "cal_commit")
        c.op = Op::CalCommit;
    else if (op == "move_distance" || op == "turn_angle") {
        c.turn = op == "turn_angle";
        c.op = c.turn ? Op::Turn : Op::Move;
        if (!c.turn && !d["speed_mm_s"].isNull()) {
            if (!integer(d["speed_mm_s"], 1, board::maxManualMmPerSecond)) return "RANGE";
            c.moveSpeed = d["speed_mm_s"].as<int>();
        }
    } else if (op == "cal_sample") {
        String kind = d["step"] | "";
        if (kind == "jog") {
            c.op = Op::Jog;
            if (!integer(d["channel"], 3, 4) || !integer(d["direction"], -1, 1) ||
                d["direction"] == 0)
                return "RANGE";
            c.a = d["channel"] == 3 ? 0 : 1;
            c.b = d["direction"];
            c.turn = d["spin"] | false;
        } else if (kind == "jog_stop")
            c.op = Op::JogStop;
        else if (kind == "map") {
            c.op = Op::Map;
            if (!integer(d["left_channel"], 3, 4))
                return "RANGE";
            c.mapping.left = d["left_channel"] == 3 ? 0 : 1;
            for (int i = 0; i < 2; i++) {
                auto m = d[i ? "right_motor_sign" : "left_motor_sign"],
                     e = d[i ? "right_encoder_sign" : "left_encoder_sign"];
                if (!integer(m, -1, 1) || !integer(e, -1, 1) || m == 0 || e == 0)
                    return "RANGE";
                c.mapping.motorSign[i] = m;
                c.mapping.encoderSign[i] = e;
            }
        } else if (kind == "start" || kind == "finish" || kind == "trial") {
            c.op = kind == "start" ? Op::Start : kind == "finish" ? Op::Finish : Op::Trial;
            if (!d["turn"].is<bool>())
                return "FIELDS";
            c.turn = d["turn"];
        } else
            return "STEP";
    } else
        return "UNKNOWN_OP";
    if (c.op == Op::Finish || c.op == Op::Trial || c.op == Op::Move || c.op == Op::Turn) {
        auto v = d[c.turn ? "angle_deg" : "distance_mm"];
        int limit = c.turn ? board::maxAngle : board::maxDistance;
        if (!v.is<float>() || !std::isfinite(v.as<float>()) || std::abs(v.as<float>()) > limit ||
            std::abs(v.as<float>()) < 1)
            return "RANGE";
        c.value = v;
        if (c.op != Op::Finish) {
            const char *key = d["request_key"] | "";
            if (!*key || strlen(key) >= sizeof(c.key))
                return "KEY";
            strlcpy(c.key, key, sizeof(c.key));
        }
    }
    return nullptr;
}
} // namespace

String handleFrame(Session &s, const String &wire, uint32_t receivedAt, bool usb, bool setupHotspot) {
    JsonDocument q, r;
    r["v"] = 1;
    r["ok"] = false;
    auto fail = [&](const char *e) {
        r["error"] = e;
        return encode(r);
    };
    if (wire.length() > 1024 || deserializeJson(q, wire) || !q.is<JsonObject>())
        return fail("BAD_FRAME");
    if (q["v"] != 1 || !q["id"].is<uint32_t>() || !q["id"].as<uint32_t>())
        return fail("VERSION_OR_ID");
    uint32_t id = q["id"];
    r["id"] = id;
    String op = q["op"] | "";
    bool hello = op == "hello";
    if (!hello && (!s.sid || q["session"] != s.sid))
        return fail("SESSION");
    if (id == s.lastId && s.previous == wire)
        return s.reply;
    if (!hello && id <= s.lastId)
        return fail("STALE_ID");
    if (hello) {
        if (s.sid)
            stopSession(s.sid);
        s = Session{};
        s.sid = (esp_random() | 2u);
        s.sid = usb ? (s.sid & ~1u) : (s.sid | 1u);
        auto state = snapshot();
        r["session"] = s.sid;
        r["boot_id"] = state.boot;
        r["device_id"] = controllerName();
        r["basic_ticks_min"] = board::minBasicTicks;
        r["basic_ticks_max"] = board::maxBasicTicks;
        r["basic_ticks_default"] = board::defaultBasicTicks;
        r["max_abs_mm_s"] = state.saved.manualSpeedLimit();
        r["max_twist_mm_s"] = board::maxSpeed;
        auto caps = r["capabilities"].to<JsonArray>();
        for (auto name : {"imu_probe", "drive", "drive_low", "drive_twist", "drive_log", "wheel_odom", "encoders", "calibration", "move_distance", "move_speed", "turn_angle"})
            caps.add(name);
        if (state.lidar.installed)
            caps.add("lidar_sectors");
    } else if (op == "imu_probe") {
        if (snapshot().owner) return fail("BUSY");
        if (const char *err = probeImu(r)) r["error"] = err;
    } else if (op == "drive_log") {
        if (const char *err = driveLogRead(q,r)) r["error"] = err;
    } else if (op.startsWith("wifi_")) {
        if (const char *error = networkCommand(op, q, r, usb || setupHotspot))
            r["error"] = error;
    } else if (op == "status") {
        describe(r, snapshot(), s.sid);
        if (q["request_key"].is<const char *>() || q["action_id"].is<uint32_t>()) {
            ActionRecord action;
            if (lookupAction(q["request_key"].as<const char *>(), q["action_id"] | uint32_t(0), action)) {
                r["action_id"] = action.id;
                r["action_state"] = action.state;
                r["action_reason"] = action.reason;
                r.remove("action_target_deg");
                r.remove("action_target_mm");
                r[action.turn ? "action_target_deg" : "action_target_mm"] = action.target;
                if (action.gyro) r["action_yaw_deg"] = action.yaw;
                else r.remove("action_yaw_deg");
                if (action.coast.started) {
                    r["brake_yaw_deg"] = action.coast.startYaw;
                    r["brake_rate_dps"] = action.coast.startRate;
                    if (action.coast.settled) {
                        r["coast_deg"] = action.coast.travel;
                        r["brake_to_confirmed_rest_ms"] = action.coast.untilSettledMs;
                    }
                }
                r["left_goal_mm"] = action.goal.target[0];
                r["right_goal_mm"] = action.goal.target[1];
                r["left_progress_mm"] = action.goal.actual[0];
                r["right_progress_mm"] = action.goal.actual[1];
            } else
                return fail("UNKNOWN_RESULT");
        }
    } else if (op == "subscribe") {
        if (!integer(q["hz"], 0, 10))
            return fail("TOPIC_OR_RATE");
        if (q["topic"] == "encoders")
            s.hz = q["hz"];
        else if (q["topic"] == "lidar_sectors" && snapshot().lidar.installed)
            s.lidarHz = q["hz"];
        else
            return fail("TOPIC_OR_RATE");
    } else {
        Command c;
        c.session = s.sid;
        c.receivedAt = receivedAt;
        c.lease = q["lease"] | uint32_t(0);
        c.window = q["window"] | uint32_t(0);
        if (auto error = decode(q, op, c))
            return fail(error);
        if (c.op == Op::Claim) {
            if (q["manual_pad"] | false) c.leaseMode = LeaseMode::ManualPad;
            if (q["precision"] | false) {
                if (c.leaseMode != LeaseMode::Standard) return fail("MODE");
                c.leaseMode = LeaseMode::Precision;
            }
        }
        auto result = submit(c);
        if (result.error) {
            r["error"] = result.error;
            const auto state = snapshot();
            r["owner"] = controlOwner(state, s.sid);
            if (!strcmp(result.error, "STALE_WINDOW") && state.owner == s.sid &&
                c.lease == state.lease) {
                r["lease"] = state.lease;
                r["window"] = state.window;
            }
        } else {
            auto state = snapshot();
            if (c.op == Op::Claim || c.op == Op::CalBegin) {
                r["accepted_ms"] = millis();
                r["lease"] = state.lease;
                r["window"] = state.window;
                r["expires_at_ms"] = state.windowTime + leaseDuration(state.leaseMode);
            }
            if (result.action)
                r["action_id"] = result.action;
        }
    }
    r["ok"] = r["error"].isNull();
    s.lastId = id;
    s.previous = op == "wifi_test" ? String() : wire;
    s.reply = encode(r);
    return s.reply;
}

String eventFrame(Session &s, uint32_t now, ControlWindow &window) {
    window = {};
    if (!s.sid)
        return {};
    auto state = snapshot();
    JsonDocument d;
    d["v"] = 1;
    d["t_ms"] = now;
    const ControlWindow current{state.lease, state.window, state.windowTime};
    if (state.owner == s.sid && s.windows.pending(current)) {
        window = current;
        d["event"] = "control_window";
        d["lease"] = state.lease;
        d["window"] = state.window;
        d["expires_at_ms"] = state.windowTime + leaseDuration(state.leaseMode);
    } else if (s.lastOwner != state.owner || s.lastReason != state.reason ||
               s.wasOnline != state.feedback.fresh(now) || s.lastAction != state.action ||
               s.lastActionState != state.actionState) {
        const bool actionChanged = s.lastAction != state.action || s.lastActionState != state.actionState;
        s.lastOwner = state.owner;
        s.lastReason = state.reason;
        s.wasOnline = state.feedback.fresh(now);
        s.lastAction = state.action;
        s.lastActionState = state.actionState;
        d["event"] = actionChanged && state.action ? "action" : "status";
        describe(d, state, s.sid);
    } else if (s.lidarHz && elapsed(now, s.lidarAt, 1000 / s.lidarHz)) {
        s.lidarAt = now;
        d["event"] = "lidar_sectors";
        const auto &lidar = state.lidar;
        d["t_ms"] = lidar.scan.capturedMs;
        d["seq"] = lidar.scan.sequence;
        auto sectors = d["sectors"].to<JsonArray>();
        for (int i = 0; i < 4; i++) {
            auto sector = sectors.add<JsonObject>();
            sector["from_deg"] = (i * 90 + 315) % 360;
            sector["to_deg"] = (i * 90 + 45) % 360;
            bool valid = lidar.fresh(now) && (lidar.scan.validMask & (1 << i));
            sector["valid"] = valid;
            if (valid)
                sector["min_mm"] = lidar.scan.clearanceMm[i];
            else
                sector["min_mm"] = nullptr;
        }
    } else if (s.hz && elapsed(now, s.telemetryAt, 1000 / s.hz)) {
        s.telemetryAt = now;
        d["event"] = "encoders";
        describe(d, state, s.sid);
        d["valid"] = state.feedback.fresh(now);
    } else
        return {};
    return encode(d);
}

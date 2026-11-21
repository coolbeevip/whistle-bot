// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include "../board/config.h"

struct Calibration {
    uint32_t revision = 0;
    int left = 0;                                       // physical index 0=M3, 1=M4
    int motorSign[2] = {1, 1}, encoderSign[2] = {1, 1}; // logical left,right
    float scale[2] = {};                                // mm per raw count
    float track = 0;                                    // effective track, mm
    bool mapped = false;
    uint32_t checks = 0; // bit 0: distance trial passed; bit 1: turn trial passed
    bool directionValid() const {
        return mapped && (left == 0 || left == 1) && std::abs(motorSign[0]) == 1 &&
               std::abs(motorSign[1]) == 1 && std::abs(encoderSign[0]) == 1 &&
               std::abs(encoderSign[1]) == 1;
    }
    bool distanceValid() const {
        return directionValid() && scale[0] > 0.001f && scale[0] < 10 && scale[1] > 0.001f &&
               scale[1] < 10;
    }
    bool valid() const { return distanceValid() && track > 20 && track < 1500;
    }
    static Calibration chassisDefaults() {
        Calibration c;
        c.mapped = true;
        c.motorSign[0] = c.encoderSign[0] = -1;
        return c;
    }
    bool distanceReady() const { return distanceValid() && (checks & 1); }
    int manualSpeedLimit() const {
        if (!distanceReady()) return board::maxSpeed;
        return std::min(board::maxManualMmPerSecond, int(board::maxBasicTicks * std::min(scale[0], scale[1])));
    }
    bool ready() const { return valid() && checks == 3; }
    bool storable() const {
        return directionValid() && (distanceValid() || (scale[0] == 0 && scale[1] == 0)) &&
               (track == 0 || valid()) && checks <= 3 &&
               (!(checks & 1) || distanceValid()) && (!(checks & 2) || valid());
    }
    int physical(int side) const { return side == 0 ? left : 1 - left; }
};

inline bool elapsed(uint32_t now, uint32_t then, uint32_t duration) {
    return uint32_t(now - then) >= duration;
}
inline bool future(uint32_t deadline, uint32_t now) { return int32_t(deadline - now) > 0; }

struct Feedback {
    uint32_t last = 0, lastChange = 0, sequence = 0;
    int32_t raw[2] = {};
    int64_t ticks[2] = {};
    bool valid = false;
    bool update(int32_t a, int32_t b, uint32_t now) {
        int32_t next[] = {a, b};
        int32_t diff[2] = {};
        if (valid) {
            for (int i = 0; i < 2; i++) {
                diff[i] = int32_t(uint32_t(next[i]) - uint32_t(raw[i]));
                if (std::abs(int64_t(diff[i])) > 100 + 45LL * uint32_t(now - last)) {
                    valid = false;
                    return false;
                }
            }
        } else {
            lastChange = now;
        }
        for (int i = 0; i < 2; i++) {
            raw[i] = next[i];
            ticks[i] += diff[i];
        }
        if (diff[0] || diff[1])
            lastChange = now;
        last = now;
        sequence++;
        valid = true;
        return true;
    }
    bool fresh(uint32_t now) const { return valid && !elapsed(now, last, board::feedbackMs); }
    bool settled(uint32_t now) const { return fresh(now) && elapsed(last, lastChange, 150); }
};

struct Goal {
    int64_t start[2] = {};
    float target[2] = {}, actual[2] = {}, tolerance = 0;
    void begin(const Calibration &cal, const Feedback &f, float value, bool turn) {
        float path = turn ? value * 0.00872664626f * cal.track : value;
        tolerance = turn ? std::max(1.f, cal.track * 0.00872664626f * 2.f) : 5.f;
        for (int i = 0; i < 2; i++) {
            start[i] = f.ticks[cal.physical(i)];
            target[i] = (turn && i == 0) ? -path : path;
            actual[i] = 0;
        }
    }
    void measure(const Calibration &cal, const Feedback &f) {
        for (int i = 0; i < 2; i++)
            actual[i] = (f.ticks[cal.physical(i)] - start[i]) * cal.scale[i] * cal.encoderSign[i];
    }
    bool close() const {
        return std::abs(target[0] - actual[0]) <= tolerance && std::abs(target[1] - actual[1]) <= tolerance;
    }
    float speed(int i) const {
        float sign = std::copysign(1.f, target[i]);
        float remaining = std::abs(target[i]) - actual[i] * sign;
        if (remaining <= tolerance) return 0;
        float progress = actual[i] * sign;
        float other = actual[1-i] * std::copysign(1.f, target[1-i]);
        float averageRemaining = std::abs(target[i]) - (progress + other) * 0.5f;
        float cruise = std::clamp(averageRemaining * 1.8f, 10.f, 60.f);
        float sync = std::clamp((other - progress) * 1.2f, -15.f, 15.f);
        return sign * std::clamp(cruise + sync, 0.f, std::min(60.f, std::max(10.f, remaining * 1.8f)));
    }
};

struct WheelOdometry {
    double x = 0, y = 0, heading = 0;
    int64_t previous[2]{};
    uint32_t revision = 0, stamp = 0;
    bool valid = false;
    void update(const Calibration &cal, const Feedback &f) {
        if (!cal.ready() || !f.valid) {
            valid = false;
            return;
        }
        double delta[2];
        bool reset = !valid || revision != cal.revision;
        for (int i = 0; i < 2; ++i) {
            auto count = f.ticks[cal.physical(i)];
            delta[i] = (count - previous[i]) * cal.encoderSign[i] * double(cal.scale[i]);
            previous[i] = count;
        }
        valid = true;
        stamp = f.last;
        revision = cal.revision;
        if (reset) {
            x = y = heading = 0;
            return;
        }
        if (!delta[0] && !delta[1]) return;
        double halfTurn = (delta[1] - delta[0]) / (2 * cal.track);
        double chord = (delta[0] + delta[1]) * 0.5;
        if (std::abs(halfTurn) > 1e-6) chord *= std::sin(halfTurn) / halfTurn;
        x += chord * std::cos(heading + halfTurn);
        y += chord * std::sin(heading + halfTurn);
        heading = std::remainder(heading + 2 * halfTurn, 6.283185307179586);
    }
};

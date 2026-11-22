// SPDX-License-Identifier: Apache-2.0
#pragma once
#include "motion.h"

// Estimate from encoder arrival times. Repeated control ticks never create zero-speed samples.
struct WheelRates {
    float ticksPerSecond[2]{};
    int64_t counts[2]{};
    uint32_t at = 0, interval = 0;
    bool initialized = false;
    void update(const Feedback &f) {
        if (!f.valid) {
            *this = {};
            return;
        }
        uint32_t ms = f.last - at;
        if (initialized && ms < minimumWindowMs) return;
        bool usable = initialized && ms < board::feedbackMs;
        for (int i = 0; i < 2; ++i) {
            ticksPerSecond[i] = usable ? (f.ticks[i] - counts[i]) * 1000.f / ms : 0;
            counts[i] = f.ticks[i];
        }
        initialized = true;
        interval = usable ? ms : 0;
        at = f.last;
    }
    static constexpr uint32_t minimumWindowMs = 40;
};

// Raw-encoder high-speed straight driving. Start from a tested speed, then
// probe for additional headroom instead of winding both loops up at maximum.
struct StraightCruise {
    static constexpr float entry = 1750.f;
    float speed = entry, loadedSeconds = 0;
    float update(float request, float slowWheel, int peakPwm, int limit, float dt, bool responsive = false) {
        speed = std::min(speed, request);
        if (peakPwm >= limit - 12) {
            loadedSeconds = std::min(0.3f, loadedSeconds + dt);
            if (loadedSeconds >= 0.12f && slowWheel < speed - 35.f)
                speed = std::max(1000.f, speed - 400.f * dt);
        } else {
            loadedSeconds = std::max(0.f, loadedSeconds - dt);
            if (!loadedSeconds && peakPwm < limit - 40 && slowWheel >= speed - std::max(55.f, (responsive ? 0.10f : 0.05f) * speed))
                speed = std::min(request, speed + (responsive ? 2550.f : 850.f) * dt);
        }
        return speed;
    }
};

// Correction is in wheel-speed units. Ignore small count mismatches and
// limit how quickly a persistent travel error can change the wheel target.
struct StraightTrim {
    float value = 0;
    float update(float lead, float speed, float deadband, float dt) {
        float magnitude = std::max(0.f, std::abs(lead) - deadband);
        float requested = std::copysign(std::min(0.45f * magnitude, 0.10f * speed), lead);
        float maxStep = 0.25f * speed * dt;
        value += std::clamp(requested - value, -maxStep, maxStep);
        return value;
    }
};

// Speeds are fractions of the selected reference rate, so the same controller
// can track encoder counts before calibration and physical wheel speeds afterwards.
struct WheelLoop {
    float reference = 0, integral = 0;
    int step(float target, float measured, float dt, float slew, int limit, bool rawTicks = false) {
        if (!target) {
            *this = {};
            return 0;
        }
        float next = reference + std::clamp(target - reference, -slew * dt, slew * dt);
        if (next * reference <= 0) integral = 0;
        if (next * reference < 0) next = 0;
        reference = next;
        float error = reference - measured;
        // Fade in friction compensation near zero so a reversal stays smooth.
        float feedforward = 110 * std::clamp(reference * 5, -1.f, 1.f) + 200 * reference;
        // Above 325 ticks/s the measured chassis needs a shallower feedforward slope.
        if (rawTicks && std::abs(reference) > 1.f)
            feedforward -= std::copysign(130.f * (std::abs(reference) - 1.f), reference);
        // Measured PWM rises more steeply above 1900 ticks/s on this drivetrain.
        if (rawTicks) {
            float ticks = std::abs(reference) * board::defaultBasicTicks;
            float extra = 0.06f * std::max(0.f, ticks - 1900.f) +
                          0.30f * std::max(0.f, ticks - 6200.f);
            feedforward += std::copysign(extra, reference);
        }
        float proportional = 120 * error;
        float authority = rawTicks ? float(limit) : 220.f;
        float candidate = std::clamp(integral + 180 * error * dt, -authority, authority);
        float sum = feedforward + proportional + candidate;
        if ((sum <= limit || error < 0) && (sum >= -limit || error > 0)) integral = candidate;
        return std::lround(std::clamp(feedforward + proportional + integral, -float(limit), float(limit)));
    }
};

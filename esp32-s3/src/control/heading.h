// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>

struct Heading {
    double degrees = 0;
    float rate = 0;
    uint32_t at = 0;
    bool ready = false;
    bool fresh(uint32_t now) const { return ready && uint32_t(now - at) < 100; }
};

// Learn the chassis vertical and gyro bias while parked on level ground.
// The unwrapped integral allows signed relative turns up to a full revolution.
class HeadingEstimator {
    float gravity[3]{}, bias[3]{};
    unsigned count = 0;
public:
    Heading heading;
    void update(uint32_t now, const float accel[3], const float gyro[3], bool parked) {
        uint32_t gap = now - heading.at;
        if (gap >= 100) *this = {};
        heading.at = now;
        if (!heading.ready) {
            float norm = 0;
            for (int i = 0; i < 3; ++i) {
                norm += accel[i] * accel[i];
                parked &= std::abs(gyro[i]) < 3;
            }
            if (!parked || norm < 0.90f || norm > 1.10f) {
                *this = {};
                return;
            }
            for (int i = 0; i < 3; ++i) {
                bias[i] += gyro[i];
                gravity[i] += accel[i];
            }
            if (++count < 104) return; // two seconds at 52 Hz
            float length = std::sqrt(gravity[0]*gravity[0]+gravity[1]*gravity[1]+gravity[2]*gravity[2]);
            if (length < count * 0.95f) { *this = {}; return; }
            for (int i = 0; i < 3; ++i) {
                gravity[i] /= length;
                bias[i] /= count;
            }
            heading.ready = true;
            return;
        }
        float rate = 0;
        for (int i = 0; i < 3; ++i)
            rate += gravity[i] * (gyro[i] - bias[i]);
        heading.degrees += (rate + heading.rate) * 0.0005 * gap;
        heading.rate = rate;
    }
};

struct PrecisionGoal {
    static constexpr float moveAcceleration = 400.f; // mm/s² wheel reference ramp
    int moveSpeed = 0;
    double origin = 0;
    float target = 0, yaw = 0, error = 0, tolerance = 0, bestError = 0;
    uint32_t progressAt = 0;
    bool turn = false;
    unsigned corrections = 0;
    bool approachingStop = false, observingRest = false, restInside = false;
    uint32_t restSince = 0;

    void begin(float value, bool turning, const Heading &h, uint32_t now, int cruiseMmS = 0) {
        *this = {};
        moveSpeed = turning ? 0 : cruiseMmS;
        origin = h.degrees;
        target = value;
        turn = turning;
        bestError = std::abs(value);
        tolerance = std::min(bestError * 0.25f, turn ? 1.5f : 5.f);
        progressAt = now;
    }

    void update(const Heading &h, float meanTravel, int speed[2], uint32_t now) {
        yaw = float(h.degrees - origin);
        float previousError = error;
        error = target - (turn ? yaw : meanTravel);
        if (std::abs(error) + tolerance * 0.5f < bestError) {
            bestError = std::abs(error);
            progressAt = now;
        }
        float remaining = std::abs(error);
        if (turn) {
            // Initial stopping-time estimate; tune from measured coast on the floor.
            constexpr float coastSeconds = 0.10f;
            float closingRate = error >= 0 ? h.rate : -h.rate;
            remaining -= std::max(0.f, closingRate) * coastSeconds;
            approachingStop = remaining <= tolerance || previousError * error < 0;
            float limit = corrections ? 24.f : 60.f;
            speed[1] = approachingStop ? 0 : std::lround(std::copysign(std::clamp(remaining * 1.8f, 9.f, limit), error));
            speed[0] = -speed[1];
        } else {
            float limit = moveSpeed ? float(moveSpeed) : 60.f;
            if (moveSpeed) {
                // Reserve braking distance before the tolerance band, with margin for wheel lag.
                float brakingSpeed = std::sqrt(2.f * (0.75f * moveAcceleration) * std::max(0.f, remaining - tolerance));
                limit = std::min(limit, std::max(9.f, brakingSpeed));
                approachingStop = previousError * error < 0;
            }
            float base = std::copysign(std::clamp(remaining * 1.8f, std::min(9.f, limit), limit), error);
            float bound = std::min(18.f, std::abs(base) * 0.5f);
            float trim = std::clamp(1.8f*yaw + 0.22f*h.rate, -bound, bound);
            speed[0] = std::lround(base + trim);
            speed[1] = std::lround(base - trim);
            if (moveSpeed) {
                for (int i = 0; i < 2; ++i)
                    speed[i] = std::clamp(speed[i], -moveSpeed, moveSpeed);
            }
        }
    }
    bool close() const { return std::abs(error) <= tolerance; }
    bool rested(const Heading &h, bool wheelsStill) {
        if (!wheelsStill || std::abs(h.rate) >= 3.f) {
            observingRest = false;
            return false;
        }
        if (!observingRest || restInside != close()) {
            observingRest = true;
            restInside = close();
            restSince = h.at;
        }
        return uint32_t(h.at - restSince) >= 150;
    }
};

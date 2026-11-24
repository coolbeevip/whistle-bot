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
    double origin = 0;
    float target = 0, yaw = 0, error = 0, tolerance = 0, bestError = 0;
    uint32_t progressAt = 0;
    bool turn = false;
    unsigned corrections = 0;

    void begin(float value, bool turning, const Heading &h, uint32_t now) {
        *this = {};
        origin = h.degrees;
        target = value;
        turn = turning;
        bestError = std::abs(value);
        tolerance = std::min(bestError * 0.25f, turn ? 1.5f : 5.f);
        progressAt = now;
    }

    void update(const Heading &h, float meanTravel, int speed[2], uint32_t now) {
        yaw = float(h.degrees - origin);
        error = target - (turn ? yaw : meanTravel);
        if (std::abs(error) + tolerance * 0.5f < bestError) {
            bestError = std::abs(error);
            progressAt = now;
        }
        float base = std::copysign(std::clamp(std::abs(error) * 1.8f, 9.f, 60.f), error);
        if (turn) {
            speed[1] = std::lround(base);
            speed[0] = -speed[1];
        } else {
            float bound = std::min(18.f, std::abs(base) * 0.5f);
            float trim = std::clamp(1.8f*yaw + 0.22f*h.rate, -bound, bound);
            speed[0] = std::lround(base + trim);
            speed[1] = std::lround(base - trim);
        }
    }
    bool close() const { return std::abs(error) <= tolerance; }
};

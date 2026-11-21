// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cmath>
#include <cstdint>

struct Battery {
    float volts = 0, filtered = 0;
    uint32_t last = 0, lowSince = 0;
    bool low = false, pending = false;

    bool fresh(uint32_t now) const { return volts > 0 && uint32_t(now - last) < 3500; }

    // Approximate pack voltage curve for three series Li-ion cells.
    // The points are initial estimates, not a measured curve for this pack.
    int percent() const {
        constexpr float voltage[] = {9.6f, 10.5f, 10.8f, 11.1f, 11.4f, 11.7f, 12.0f, 12.6f};
        constexpr int charge[] = {0, 5, 10, 20, 40, 60, 80, 100};
        if (filtered <= voltage[0]) return 0;
        for (unsigned i = 1; i < sizeof(charge) / sizeof(charge[0]); ++i) {
            if (filtered <= voltage[i]) {
                float part = (filtered - voltage[i-1]) / (voltage[i] - voltage[i-1]);
                return int(std::floor(charge[i-1] + part * (charge[i] - charge[i-1])));
            }
        }
        return 100;
    }

    void update(float value, uint32_t now) {
        if (!std::isfinite(value) || value < 5 || value > 15) return;
        if (!fresh(now)) {
            filtered = value;
            low = pending = false;
        } else {
            filtered += (value - filtered) * 0.35f;
        }
        volts = value;
        last = now;
        int soc = percent();
        if (soc < 5) {
            if (!pending) lowSince = now;
            pending = true;
            if (uint32_t(now - lowSince) >= 5000) low = true;
        } else {
            pending = false;
            if (soc >= 8) low = false;
        }
    }
};

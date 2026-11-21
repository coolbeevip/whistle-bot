// SPDX-License-Identifier: Apache-2.0
#pragma once
#include "motion.h"

// Collect observations only in the active calibration session. Distances
// refer to the axle midpoint; encoder counts here already use forward sign.
struct CalibrationSamples {
    double distance = 0, rotationWidth = 0;
    int64_t ticks[2]{};
    unsigned turns = 0;

    bool addTravel(Calibration &cal, double mm, const int64_t delta[2]) {
        if (!std::isfinite(mm) || !mm)
            return false;
        for (int i = 0; i < 2; ++i) {
            if (!delta[i])
                return false;
            double scale = mm / delta[i];
            if (!(scale > 0.001 && scale < 10))
                return false;
        }
        distance += std::abs(mm);
        for (int i = 0; i < 2; ++i) {
            ticks[i] += std::abs(delta[i]);
            cal.scale[i] = distance / ticks[i];
        }
        turns = 0;
        rotationWidth = 0;
        cal.checks = 0; // Keep measured track; the new scale requires both trials again.
        return true;
    }
    bool addTurn(Calibration &cal, double degrees, const int64_t delta[2]) {
        if (!degrees || delta[0] * degrees >= 0 || delta[1] * degrees <= 0)
            return false;
        double width = (delta[1] * cal.scale[1] - delta[0] * cal.scale[0]) / (degrees * 0.01745329252);
        if (!(width > 20 && width < 1500))
            return false;
        rotationWidth += width;
        cal.track = rotationWidth / ++turns;
        cal.checks &= 1;
        return true;
    }
};

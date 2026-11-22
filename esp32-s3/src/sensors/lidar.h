// SPDX-License-Identifier: Apache-2.0
#pragma once
#include "../control/motion.h"
#include <array>

// Adapter supplies conservative minimum clearance for calibrated sectors in
// the chassis frame, including the chassis footprint. Unknown = invalid bit.
struct ScanSummary {
    uint32_t sequence = 0, capturedMs = 0;
    uint8_t validMask = 0; // front, left, rear, right
    std::array<uint16_t, 4> clearanceMm{};
};
struct LidarState {
    bool installed = false, required = false, received = false;
    uint32_t maxAgeMs = 0;
    uint16_t stoppingMm = 0; // commissioned at the maximum permitted speed
    ScanSummary scan{};
    bool accept(const ScanSummary &next, uint32_t now) {
        if (!installed || elapsed(now, next.capturedMs, maxAgeMs))
            return false;
        if (received &&
            (int32_t(next.sequence - scan.sequence) <= 0 || int32_t(next.capturedMs - scan.capturedMs) < 0))
            return false;
        scan = next;
        received = true;
        return true;
    }
    bool fresh(uint32_t now) const { return received && !elapsed(now, scan.capturedMs, maxAgeMs); }
    bool permits(int left, int right, uint32_t now) const {
        if (!required || (!left && !right))
            return true;
        if (!installed || !stoppingMm || !fresh(now))
            return false;
        // A curve or pivot sweeps the flanks. Require full coverage until
        // a hardware-specific swept footprint has been validated.
        uint8_t sectors = left == right ? (left > 0 ? 1 : 4) : 15;
        if ((scan.validMask & sectors) != sectors)
            return false;
        for (unsigned i = 0; i < 4; i++)
            if ((sectors & (1 << i)) && scan.clearanceMm[i] <= stoppingMm)
                return false;
        return true;
    }
};
class LidarSource {
  public:
    virtual ~LidarSource() = default;
    // Poll must use bounded work, no blocking reads, in the sensor task.
    virtual bool poll(ScanSummary &summary) = 0;
};

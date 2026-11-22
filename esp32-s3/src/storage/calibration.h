// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <Preferences.h>
#include <cstddef>
#include "../control/motion.h"

inline bool storedCalibration(Calibration &data, bool write) {
    Preferences nvs;
    if (!nvs.begin("chassis-v1", !write))
        return false;
    constexpr auto key = "stages-m3-m4";
    if (!write && !nvs.isKey(key)) {
        // Old firmware stored only fully verified calibrations.
        Calibration legacy{};
        constexpr size_t oldSize = offsetof(Calibration, checks);
        if (nvs.getBytesLength("cal-m3-m4") != oldSize ||
            nvs.getBytes("cal-m3-m4", &legacy, oldSize) != oldSize || !legacy.valid())
            return false;
        legacy.checks = 3;
        data = legacy;
        return true;
    }
    if (write && !data.storable())
        return false;
    if (write && nvs.putBytes(key, &data, sizeof(data)) != sizeof(data))
        return false;
    Calibration checked;
    if (nvs.getBytes(key, &checked, sizeof(checked)) != sizeof(checked) || !checked.storable())
        return false;
    if (write && memcmp(&checked, &data, sizeof(data)) != 0)
        return false;
    data = checked;
    return true;
}

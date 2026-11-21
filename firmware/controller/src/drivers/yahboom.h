// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <HardwareSerial.h>
#include "../sensors/battery.h"
#include "../control/motion.h"

class Yahboom {
    char line[128]{};
    size_t used = 0;
    bool discard = false;
    int prior[2] = {};
    uint32_t sentAt = 0;

  public:
    int transmittedPwm(int channel) const { return prior[channel]; }
    Feedback feedback;
    Battery battery;
    void requestBattery();
    void begin();
    bool read(uint32_t now);
    bool output(int m3, int m4, uint32_t now, bool force = false);
    void requestFeedback();
};

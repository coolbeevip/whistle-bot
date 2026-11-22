// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cstdint>
#include <ArduinoJson.h>

struct DriveLinkTiming {
    uint32_t sentWindow = 0, openedAt = 0, queuedAt = 0, enqueueFailures = 0;
    uint32_t driveWindow = 0, receivedAt = 0, acceptedAt = 0;
};

struct DriveSample {
    DriveLinkTiming link;
    uint32_t ms;
    int requested[2], target[2], measured[2], pwm[2];
    int pwmLimit, batteryMv, cruiseLimit;
    uint32_t feedbackAge;
    bool responsive;
};

void startDriveLog();
bool driveLogSaving();
void recordDriveSample(const DriveSample &row, bool moving, bool released, const char *reason);
const char *driveLogRead(JsonDocument &request, JsonDocument &reply);

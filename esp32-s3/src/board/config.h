// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cstdint>

namespace board {
constexpr int rx = 18, tx = 17;
constexpr int imuSda = 8, imuScl = 9;
constexpr unsigned baud = 115200;
constexpr int maxSpeed = 100;     // mm/s, commissioning limit
constexpr int maxDistance = 3000; // mm per command
constexpr int maxAngle = 360;     // degrees per command
constexpr int manualPwm = 400;    // legacy basic-mode PWM limit
constexpr int basicTicksPerSecond = 200; // old drive_low clients
constexpr int minBasicTicks = 150, maxBasicTicks = 9000, defaultBasicTicks = 325;
constexpr int driverPwmRange = 3600; // Yahboom direct PWM command magnitude
constexpr int maxManualMmPerSecond = 1060; // 300 rpm with the fitted 67.5 mm tires
constexpr float referenceMmPerSecond = 60.f;
constexpr int jogPwm = 300;       // calibration jog output
constexpr uint32_t windowMs = 100;
constexpr uint32_t leaseMs = 300, webDriveLeaseMs = 450;
constexpr uint32_t feedbackMs = 300;
} // namespace board

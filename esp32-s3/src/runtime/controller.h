// SPDX-License-Identifier: Apache-2.0
#pragma once
#include "../control/motion.h"
#include "../control/lease_windows.h"
#include "../protocol/window_delivery.h"
#include "../sensors/lidar.h"
#include "../sensors/battery.h"

enum class Op {
    Release,
    Claim,
    Drive,
    DriveLow,
    Twist,
    Stop,
    Move,
    Turn,
    Beat,
    CalBegin,
    CalCancel,
    CalCommit,
    CalCheckpoint,
    Jog,
    JogStop,
    Map,
    Start,
    Finish,
    Trial
};
struct Command {
    Op op{};
    uint32_t session = 0, lease = 0, window = 0, receivedAt = 0;
    int a = 0, b = 0;
    int moveSpeed = 0; // Optional Move cruise ceiling in mm/s.
    float value = 0;
    bool turn = false, responsive = false;
    LeaseMode leaseMode = LeaseMode::Standard;
    Calibration mapping{};
    char key[41]{};
    const char *releaseReason = "released";
};
struct Result {
    const char *error = nullptr;
    uint32_t action = 0;
};
struct TurnCoast {
    bool started = false, settled = false;
    float startYaw = 0, startRate = 0, travel = 0;
    uint32_t untilSettledMs = 0;
};
struct Snapshot {
    uint32_t owner = 0, lease = 0, window = 0, windowTime = 0, boot = 0;
    Feedback feedback{};
    Battery battery{};
    Calibration saved{}, draft{};
    LidarState lidar{};
    Goal goal{};
    WheelOdometry odom{};
    uint32_t action = 0;
    bool yawReady = false, gyroAction = false;
    float yawProgress = 0;
    float actionTarget = 0;
    bool turnAction = false;
    TurnCoast coast{};
    const char *actionReason = "idle";
    int wheelSpeed[2]{}, manualDir[2]{};
    float measuredTicks[2]{}, referenceTicks[2]{};
    int pwm[2]{}; // logical wheel order, physical UART sign
    uint32_t rateAt = 0, rateInterval = 0;
    LeaseMode leaseMode = LeaseMode::Standard;
    bool cal = false, running = false, stopping = false;
    const char *reason = "boot", *actionState = "idle";
    uint32_t maxLoopUs = 0, maxWakeUs = 0, overruns = 0;
};
void startController(LidarSource *lidar = nullptr, LidarState config = {});
Snapshot snapshot();
void recordWindowAttempt(ControlWindow window, bool queued, uint32_t at);
Result submit(const Command &cmd);
void stopSession(uint32_t session); // released transport
struct ActionRecord {
    uint32_t id = 0, session = 0;
    bool turn = false;
    float target = 0;
    bool gyro = false;
    TurnCoast coast{};
    float yaw = 0;
    const char *state = "idle", *reason = "idle";
    Goal goal{};
};
bool lookupAction(const char *key, uint32_t id, ActionRecord &record);

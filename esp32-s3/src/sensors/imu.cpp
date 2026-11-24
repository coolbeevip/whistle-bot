// SPDX-License-Identifier: Apache-2.0
#include "imu.h"
#include "../board/config.h"
#include <Wire.h>
#include "../runtime/controller.h"

namespace {
struct Sample {
    Heading heading;
    uint32_t at = 0;
    uint8_t address = 0, id = 0;
    int16_t axes[6]{}; // gyro XYZ, then accelerometer XYZ
    const char *error = "IMU_NO_RESPONSE";
    bool valid = false;
};
Sample latest;
portMUX_TYPE guard = portMUX_INITIALIZER_UNLOCKED;

Sample sensorSnapshot() {
    portENTER_CRITICAL(&guard);
    Sample copy = latest;
    portEXIT_CRITICAL(&guard);
    return copy;
}

bool readBytes(uint8_t addr, uint8_t reg, uint8_t *bytes, size_t count) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    if (Wire.endTransmission(false) || Wire.requestFrom(addr, count) != count) return false;
    for (size_t i = 0; i < count; ++i) bytes[i] = Wire.read();
    return true;
}

bool writeReg(uint8_t addr, uint8_t reg, uint8_t value) {
    Wire.beginTransmission(addr);
    Wire.write(reg);
    Wire.write(value);
    return Wire.endTransmission() == 0;
}

bool configure(Sample &s) {
    s = {};
    for (uint8_t addr : {0x6A, 0x6B}) {
        uint8_t id;
        if (!readBytes(addr, 0x0F, &id, 1)) continue;
        s.address = addr;
        s.id = id;
        if (id != 0x6B) { s.error = "IMU_UNEXPECTED_ID"; continue; }
        // CTRL3_C: block data update + auto-increment. Both sensors at 52 Hz.
        if (!writeReg(addr, 0x12, 0x44) || !writeReg(addr, 0x10, 0x30) ||
            !writeReg(addr, 0x11, 0x30)) { s.error = "IMU_CONFIG"; return false; }
        s.at = millis();
        s.error = nullptr;
        return true;
    }
    return false;
}

void worker(void *) {
    bool started = false, configured = false;
    Sample s;
    HeadingEstimator estimator;
    for (;;) {
        if (!started) {
            started = Wire.begin(board::imuSda, board::imuScl, 100000);
            if (started) Wire.setTimeOut(20);
        }
        if (!started) s.error = "I2C_INIT";
        else if (!configured) { estimator = {}; configured = configure(s); }
        else {
            uint8_t status, bytes[12];
            if (!readBytes(s.address, 0x1E, &status, 1) || ((status & 3) == 3 &&
                !readBytes(s.address, 0x22, bytes, sizeof(bytes)))) {
                s.valid = false;
                s.error = "IMU_NO_DATA";
                configured = false;
            } else if ((status & 3) == 3) {
                for (unsigned i = 0; i < 6; ++i)
                    s.axes[i] = int16_t(bytes[2*i] | (uint16_t(bytes[2*i+1]) << 8));
                s.at = millis();
                s.valid = true;
                float accel[3], gyro[3];
                bool clipped = false;
                for (int i = 0; i < 3; ++i) {
                    accel[i] = s.axes[i+3] * 0.000061f;
                    gyro[i] = s.axes[i] * 0.00875f;
                    clipped |= std::abs(int(s.axes[i])) >= 32700;
                }
                if (clipped) estimator = {};
                else {
                    bool parked = false;
                    if (!estimator.heading.ready) {
                        const auto state = ::snapshot();
                        parked = !state.owner && !state.stopping &&
                            (!state.feedback.fresh(s.at) || state.feedback.settled(s.at));
                    }
                    estimator.update(s.at, accel, gyro, parked);
                }
                s.heading = estimator.heading;
            } else if (millis() - s.at > 120) {
                s.valid = false;
                configured = false;
                s.error = "IMU_NO_DATA";
            }
        }
        portENTER_CRITICAL(&guard);
        latest = s;
        portEXIT_CRITICAL(&guard);
        vTaskDelay(pdMS_TO_TICKS(configured ? 10 : 1000));
    }
}
}

Heading imuHeading() {
    const auto s = sensorSnapshot();
    return s.valid ? s.heading : Heading{};
}

void startImu() {
    xTaskCreate(worker, "imu", 4096, nullptr, 1, nullptr);
}

const char *probeImu(JsonDocument &reply) {
    auto s = sensorSnapshot();
    if (s.address) {
        reply["address"] = s.address;
        reply["who_am_i"] = s.id;
    }
    return s.error;
}

void describeImu(JsonDocument &reply) {
    auto s = sensorSnapshot();
    if (!s.valid || millis() - s.at > 500) return;
    auto imu = reply["imu"].to<JsonObject>();
    imu["t_ms"] = s.at;
    if (s.heading.fresh(millis())) imu["yaw_rate_dps"] = s.heading.rate;
    auto accel = imu["accel_g"].to<JsonArray>();
    auto gyro = imu["gyro_dps"].to<JsonArray>();
    for (unsigned i = 0; i < 3; ++i) {
        accel.add(s.axes[3+i] * 0.000061f);
        gyro.add(s.axes[i] * 0.00875f);
    }
}

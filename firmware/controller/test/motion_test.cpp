// SPDX-License-Identifier: Apache-2.0
// Host test: c++ -std=c++17 test/motion_test.cpp -o /tmp/motion_test
#include "../src/control/calibration.h"
#include "../src/sensors/lidar.h"
#include "../src/control/wheel.h"
#include <cassert>
#include <climits>
#include <iostream>

int main() {
    assert(future(5, UINT32_MAX - 3));
    assert(!future(UINT32_MAX - 3, 5));
    Feedback f;
    assert(!f.fresh(100));
    assert(f.update(INT32_MAX - 1, 100, 100));
    assert(f.update(INT32_MIN + 1, 99, 110));
    assert(f.ticks[0] == 3 && f.ticks[1] == -1);
    assert(!f.settled(120));
    assert(f.update(INT32_MIN + 1, 99, 270));
    assert(f.settled(270) && !f.settled(570));
    assert(!f.update(0, 0, 271));
    assert(!f.fresh(271));

    auto chassis = Calibration::chassisDefaults();
    assert(chassis.directionValid() && !chassis.distanceReady() && !chassis.ready());
    assert(chassis.physical(0) == 0 && chassis.motorSign[0] == -1 && chassis.encoderSign[0] == -1);
    assert(chassis.physical(1) == 1 && chassis.motorSign[1] == 1 && chassis.encoderSign[1] == 1);
    Calibration cal;
    cal.left = 1;
    cal.mapped = true;
    cal.encoderSign[0] = -1;
    CalibrationSamples samples;
    int64_t forward[] = {1000, 1200}, reverse[] = {-1000, -1200}, wrong[] = {1000, -400};
    assert(!samples.addTravel(cal, 100, wrong));
    assert(samples.addTravel(cal, 100, forward));
    assert(samples.addTravel(cal, -100, reverse));
    assert(std::abs(cal.scale[0] - 0.1) < 1e-6);
    int64_t turn[] = {-1571, 1885};
    assert(samples.addTurn(cal, 90, turn));
    assert(std::abs(cal.track - 200) < 0.2 && cal.valid());

    Calibration staged = cal;
    staged.checks = 3;
    assert(staged.storable() && staged.ready());
    CalibrationSamples angleOnly;
    assert(angleOnly.addTurn(staged, 90, turn));
    assert(staged.checks == 1 && staged.distanceValid() && !staged.ready());
    float previousTrack = staged.track;
    assert(angleOnly.addTravel(staged, 100, forward));
    assert(staged.checks == 0 && staged.track == previousTrack && staged.storable());
    staged.track = 0;
    assert(staged.storable() && !staged.valid());
    staged.checks = 2;
    assert(!staged.storable());
    staged = Calibration{};
    staged.mapped = true;
    assert(staged.storable() && !staged.distanceValid() && !staged.ready());

    f = {};
    f.update(0, 0, 100);
    Goal g;
    g.begin(cal, f, -100, false);
    assert(g.speed(0) < 0 && g.speed(1) < 0);
    f.update(-1200, 1000, 200);
    g.measure(cal, f);
    assert(g.close());
    g.begin(cal, f, 90, true);
    assert(g.speed(0) < 0 && g.speed(1) > 0);
    f.update(685, 2571, 300);
    g.measure(cal, f);
    assert(g.close());
    // Equal axle-average distance cannot hide a stalled wheel.
    g.actual[0] = 0;
    g.actual[1] = g.target[1] + g.target[0];
    assert(!g.close());
    // A shared path slows the leading side in both straight and pivot movements.
    for (bool spin : {false, true}) {
        for (int direction : {-1, 1}) {
            g.begin(cal, f, direction * 90, spin);
            g.actual[0] = std::copysign(16.f, g.target[0]);
            assert(std::abs(g.speed(0)) < std::abs(g.speed(1)));
            assert(g.speed(0) * g.target[0] > 0 && g.speed(1) * g.target[1] > 0);
        }
    }
    Feedback fb;
    WheelRates rates;
    fb.update(1000, 500, 200);
    rates.update(fb);
    fb.update(1025, 450, 250);
    rates.update(fb);
    assert(rates.interval == 50 && rates.ticksPerSecond[0] == 500 && rates.ticksPerSecond[1] == -1000);
    rates.update(fb);
    assert(rates.at == 250 && rates.ticksPerSecond[0] == 500);
    fb.update(1500, 450, 620);
    rates.update(fb);
    assert(rates.interval == 0 && rates.ticksPerSecond[0] == 0);

    WheelLoop manual;
    int manualOutput = 0;
    for (int i = 0; i < 1100; ++i) {
        manualOutput = manual.step(6000.f / 325, manual.reference * 0.97f, .01f, 2.66f, board::driverPwmRange, true);
        assert(std::abs(manualOutput) <= 3600);
    }
    assert(manualOutput > 650);
    assert(manual.step(0, 18, .01f, 2.66f, board::driverPwmRange, true) == 0);
    auto verified = Calibration::chassisDefaults();
    verified.checks = 1;
    verified.scale[0] = .10f;
    verified.scale[1] = .12f;
    assert(verified.manualSpeedLimit() == 900);
    StraightCruise smoothCruise, responsiveCruise;
    assert(responsiveCruise.update(4000, 1750, 500, 3600, .01f, true) >
           smoothCruise.update(4000, 1750, 500, 3600, .01f));
    StraightCruise cruise;
    for (int i = 0; i < 100; ++i) cruise.update(2500, 800, 420, 650, 0.01f);
    assert(cruise.speed == 1750);
    for (int i = 0; i < 200; ++i) cruise.update(2500, 2200, 580, 650, 0.01f);
    assert(cruise.speed >= 2200 && cruise.speed < 2350);
    for (int i = 0; i < 200; ++i) cruise.update(2500, 1830, 650, 650, 0.01f);
    assert(cruise.speed >= 1830 && cruise.speed <= 1865);
    StraightTrim trim;
    for (int i = 0; i < 100; ++i)
        assert(trim.update(i % 2 ? 4 : -4, 325, 4, 0.01f) == 0);
    float initialTrim = trim.update(100, 325, 4, 0.01f);
    assert(initialTrim > 0 && initialTrim < 1);
    for (int i = 0; i < 100; ++i) trim.update(1000, 325, 4, 0.01f);
    assert(std::abs(trim.value - 32.5f) < 0.001f);
    assert(trim.update(-1000, 325, 4, 0.01f) > 31);
    for (int i = 0; i < 100; ++i) trim.update(0, 325, 4, 0.01f);
    assert(trim.value == 0);
    WheelLoop loops[2];
    float response[2]{};
    for (int k = 0; k < 2400; ++k) {
        for (int i = 0; i < 2; ++i) {
            int pwm = loops[i].step(1, response[i], 0.01f, 2.66f, 400);
            assert(std::abs(pwm) <= 400);
            float gain = i ? 0.005f : 0.003f;
            response[i] += 0.1f * (gain * pwm - response[i]);
        }
    }
    assert(std::abs(response[0] - 1) < 0.02 && std::abs(response[1] - 1) < 0.02);
    float prev = loops[0].reference;
    for (int k = 0; k < 100; ++k) {
        loops[0].step(-1, 0, 0.01f, 2.66f, 400);
        assert(std::abs(prev - loops[0].reference) <= 0.027f);
        prev = loops[0].reference;
    }
    assert(prev == -1 && loops[0].step(0, 0, 0.01f, 2.66f, 400) == 0);

    WheelOdometry pose;
    Calibration geom = chassis;
    geom.scale[0] = geom.scale[1] = 1;
    geom.track = 100;
    geom.checks = 3;
    pose.update(geom, fb);
    fb.update(1400, 550, 670);
    pose.update(geom, fb);
    assert(pose.valid && pose.x == 100 && pose.y == 0);
    fb.update(1450, 600, 720);
    pose.update(geom, fb);
    assert(pose.heading == 1 && pose.x == 100);
    ++geom.revision;
    pose.update(geom, fb);
    assert(pose.x == 0 && pose.heading == 0);
    LidarState lidar;
    assert(lidar.permits(20, 20, 100)); // optional on this chassis
    lidar.required = true;
    assert(!lidar.permits(20, 20, 100));
    lidar.installed = true;
    lidar.maxAgeMs = 100;
    lidar.stoppingMm = 150;
    ScanSummary scan{1, 100, 1, {300, 0, 0, 0}};
    assert(lidar.accept(scan, 100) && lidar.permits(20, 20, 100));
    assert(!lidar.permits(-20, -20, 100) && !lidar.permits(-10, 10, 100));
    assert(!lidar.accept(scan, 150) && !lidar.permits(20, 20, 200));
    scan = {2, 201, 15, {100, 200, 200, 200}};
    assert(lidar.accept(scan, 202) && !lidar.permits(20, 20, 202));
    assert(lidar.permits(0, 0, 202));
    std::cout << "Encoder wrap, timeouts, signed calibration and differential goals passed.\n";
}

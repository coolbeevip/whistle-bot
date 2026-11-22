// SPDX-License-Identifier: Apache-2.0
#include "controller.h"
#include "../storage/drive_log.h"
#include "../control/wheel.h"
#include "../control/calibration.h"
#include "../drivers/yahboom.h"
#include "../storage/calibration.h"
#include <Arduino.h>
#include <esp_random.h>
#include <esp_timer.h>

namespace {
Yahboom motor;
Snapshot s, published;
portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
TaskHandle_t runner;
QueueHandle_t inbox, replies, stopReplies, feedbackQueue;
bool urgentStop = false;
esp_timer_handle_t periodic, leaseTimer;
struct FeedbackSample {
    Feedback data;
    uint32_t resets;
    Battery battery;
};
QueueHandle_t scanQueue;
uint32_t encoderResets;
Feedback observed;

uint32_t expires, oldWindow, windowAt, oldWindowAt, jogEnd, finishAt, goalStart, lastProbe, nextAction;
int jog[2]{};
int straightDirection = 0;
StraightTrim straightTrim;
StraightCruise straightCruise;
int requestedTicks = 0;
bool responsiveDrive = false;
int64_t straightStart[2]{};
bool braking = false, sampling = false, sampleTurn = false, trial = false, saving = false;
int64_t baseline[2]{};
CalibrationSamples samples;
WheelLoop wheel[2];
WheelRates rates;
uint32_t lastStep, lastProgress[2]{};
struct History : ActionRecord {
    char key[41]{};
};
History history[16];
unsigned cursor;
uint32_t gone = 0;
Calibration pendingSave;
QueueHandle_t saveJobs, saveDone;
uint32_t randId() {
    uint32_t n = esp_random();
    return n ? n : 1;
}
void publish() {
    s.feedback = observed;
    portENTER_CRITICAL(&lock);
    published = s;
    portEXIT_CRITICAL(&lock);
}
void stop(const char *why, uint32_t now, const char *outcome = "cancelled") {
    if (s.running) {
        s.actionState = outcome;
        portENTER_CRITICAL(&lock);
        for (auto &h : history)
            if (h.id == s.action) {
                h.state = outcome;
                h.reason = why;
                h.goal = s.goal;
            }
        portEXIT_CRITICAL(&lock);
    }
    s.running = false;
    s.stopping = true;
    braking = false;
    sampling = false;
    trial = false;
    s.owner = 0;
    s.lease = 0;
    s.window = 0;
    oldWindow = 0;
    s.cal = false;
    jogEnd = 0;
    straightDirection = 0;
    for (int i = 0; i < 2; i++) {
        s.manualDir[i] = s.wheelSpeed[i] = 0;
        wheel[i] = {};
        s.referenceTicks[i] = 0;
    }
    s.reason = motor.output(0, 0, now, true) ? why : "UART_TX";
    finishAt = now;
}
void newWindow(uint32_t now) {
    oldWindow = s.window;
    oldWindowAt = windowAt;
    s.window = randId();
    windowAt = s.windowTime = now;
}
const char *refresh(const Command &c, uint32_t now) {
    if (!s.owner || c.session != s.owner || c.lease != s.lease || !future(expires, now))
        return "NOT_OWNER";
    uint32_t origin;
    if (c.window && c.window == s.window)
        origin = windowAt;
    else if (c.window && c.window == oldWindow)
        origin = oldWindowAt;
    else
        return "STALE_WINDOW";
    if (elapsed(now, origin, board::leaseMs))
        return "STALE_WINDOW";
    expires = origin + board::leaseMs;
    return nullptr;
}
Result execute(const Command &c, uint32_t now) {
    auto &f = observed;
    if (c.op == Op::Claim || c.op == Op::CalBegin) {
        if (s.owner || s.stopping || saving || driveLogSaving())
            return {"BUSY"};
        if (!f.settled(now))
            return {"NOT_READY"};
        if (c.op == Op::Claim && !s.saved.directionValid())
            return {"CAL_REQUIRED"};
        s.cal = c.op == Op::CalBegin;
        s.owner = c.session;
        s.lease = randId();
        s.draft = s.saved;
        samples = {};
        newWindow(now);
        expires = now + board::leaseMs;
        s.reason = "ready";
        return {};
    }
    if (!s.owner || c.session != s.owner || c.lease != s.lease)
        return {"NOT_OWNER"};
    if (c.op == Op::Release || (c.op == Op::CalCancel && s.cal)) {
        stop(c.op == Op::Release ? "released" : "cal_cancel", now);
        return {};
    }
    if (c.op == Op::JogStop && s.cal) {
        jogEnd = 0;
        motor.output(0, 0, now, true);
        return {};
    }
    if (c.op == Op::Beat && !s.cal && !s.running)
        return {"MODE"};
    if (!f.fresh(now))
        return {"NO_FEEDBACK"};
    if (c.op == Op::Move || c.op == Op::Turn || c.op == Op::Trial) {
        for (const auto &record : history)
            if (record.id && strcmp(record.key, c.key) == 0)
                return record.session == c.session && record.turn == c.turn && record.target == c.value
                           ? Result{nullptr, record.id}
                           : Result{"CONFLICT"};
    }
    if (const char *err = refresh(c, now))
        return {err};
    if (c.op == Op::Beat)
        return {};
    if (s.running)
        return {"BUSY"};
    auto &d = s.draft;
    switch (c.op) {
    case Op::DriveLow:
        if (s.cal) return {"MODE"};
        s.wheelSpeed[0] = s.wheelSpeed[1] = 0;
        responsiveDrive = c.responsive;
        requestedTicks = static_cast<int>(c.value);
        s.manualDir[0] = c.a;
        s.manualDir[1] = c.b;
        return {};
    case Op::Twist: {
        if (s.cal) return {"MODE"};
        if (!s.saved.ready()) return {"CAL_REQUIRED"};
        responsiveDrive = false;
        float halfDifference = c.b * 0.0005f * s.saved.track; // mrad/s and mm
        float left = c.a - halfDifference, right = c.a + halfDifference;
        float ratio = std::max(1.f, std::max(std::abs(left), std::abs(right)) / board::maxSpeed);
        s.manualDir[0] = s.manualDir[1] = 0;
        s.wheelSpeed[0] = std::lround(left / ratio);
        s.wheelSpeed[1] = std::lround(right / ratio);
        return {};
    }
    case Op::Drive:
        if (s.cal)
            return {"MODE"};
        if (!s.saved.distanceReady()) return {"CAL_REQUIRED"};
        if (std::max(std::abs(c.a), std::abs(c.b)) > s.saved.manualSpeedLimit()) return {"RANGE"};
        s.manualDir[0] = s.manualDir[1] = 0;
        responsiveDrive = c.responsive;
        s.wheelSpeed[0] = c.a;
        s.wheelSpeed[1] = c.b;
        return {};
    case Op::Jog:
        if (!s.cal || jogEnd || (sampling && !sampleTurn))
            return {"MODE"};
        jog[c.a] = c.b * board::jogPwm;
        jog[1 - c.a] = 0;
        if (c.turn && d.mapped) {
            jog[d.physical(0)] = -c.b * d.motorSign[0] * board::jogPwm;
            jog[d.physical(1)] = c.b * d.motorSign[1] * board::jogPwm;
        }
        jogEnd = now + 250;
        return {};
    case Op::Map:
        if (!s.cal || !f.settled(now) || sampling || jogEnd)
            return {"MODE"};
        if (d.mapped && d.left == c.mapping.left &&
            std::equal(d.motorSign, d.motorSign + 2, c.mapping.motorSign) &&
            std::equal(d.encoderSign, d.encoderSign + 2, c.mapping.encoderSign))
            return {};
        d = c.mapping;
        d.mapped = true;
        samples = {};
        return {};
    case Op::Start:
        if (!s.cal || !d.mapped || sampling || jogEnd || !f.settled(now))
            return {"MODE"};
        if (c.turn && !d.distanceValid())
            return {"SCALE_REQUIRED"};
        baseline[0] = f.ticks[0];
        baseline[1] = f.ticks[1];
        sampling = true;
        sampleTurn = c.turn;
        return {};
    case Op::Finish: {
        if (!s.cal || !sampling || sampleTurn != c.turn || jogEnd || !f.settled(now))
            return {"MODE"};
        int64_t ticks[2];
        for (int i = 0; i < 2; i++)
            ticks[i] = (f.ticks[d.physical(i)] - baseline[d.physical(i)]) * d.encoderSign[i];
        sampling = false;
        bool accepted = c.turn ? samples.addTurn(d, c.value, ticks) : samples.addTravel(d, c.value, ticks);
        if (!accepted)
            return {"BAD_SAMPLE"};
        return {};
    }
    case Op::CalCommit:
        if (!d.ready())
            return {"NOT_READY"};
        [[fallthrough]];
    case Op::CalCheckpoint:
        if (!s.cal || !d.storable() || sampling || jogEnd ||
            !f.settled(now))
            return {"NOT_READY"};
        pendingSave = d;
        pendingSave.revision = s.saved.revision + 1;
        stop("saving", now);
        saving = true;
        xQueueSend(saveJobs, &pendingSave, 0);
        return {};
    case Op::Move:
    case Op::Turn:
    case Op::Trial: {
        trial = c.op == Op::Trial;
        if (trial != s.cal || sampling || jogEnd || !f.settled(now))
            return {"MODE"};
        const Calibration &cal = trial ? d : s.saved;
        if (trial ? !(c.turn ? cal.valid() : cal.distanceValid()) : !(c.turn ? cal.ready() : cal.distanceReady()))
            return {"CAL_REQUIRED"};
        s.manualDir[0] = s.manualDir[1] = 0;
        s.action = ++nextAction;
        portENTER_CRITICAL(&lock);
        History &h = history[cursor++ % 16];
        strlcpy(h.key, c.key, sizeof(h.key));
        h.id = s.action;
        h.turn = c.turn;
        h.session = c.session;
        h.target = c.value;
        h.state = "running";
        h.reason = "running";
        portEXIT_CRITICAL(&lock);
        s.goal.begin(cal, f, c.value, c.turn);
        goalStart = now;
        s.running = true;
        braking = false;
        s.actionState = "running";
        return {nullptr, s.action};
    }
    default:
        return {"MODE"};
    }
}
void tick(uint32_t now) {
    auto &f = observed;
    ScanSummary scan;
    if (scanQueue && xQueueReceive(scanQueue, &scan, 0))
        s.lidar.accept(scan, now);
    FeedbackSample sample;
    if (xQueueReceive(feedbackQueue, &sample, 0) == pdTRUE) {
        observed = sample.data;
        s.battery = sample.battery;
        if (encoderResets != sample.resets) {
            rates = {};
            s.odom.valid = false;
            stop("ENCODER_RESET", now, "failed");
        }
        encoderResets = sample.resets;
    }
    if (s.owner && (!future(expires, now) || !f.fresh(now)))
        stop(f.fresh(now) ? "timeout" : "feedback_lost", now);
    if (s.owner && elapsed(now, windowAt, 100))
        newWindow(now);
    if (!f.fresh(now) && elapsed(now, lastProbe, 500)) {
        motor.output(0, 0, now, true);
        motor.requestFeedback();
        lastProbe = now;
    }
    if (s.stopping && !saving && elapsed(now, finishAt, 150) && f.settled(now))
        s.stopping = false;
    uint32_t lost;
    portENTER_CRITICAL(&lock);
    lost = gone;
    gone = 0;
    bool urgent = urgentStop;
    urgentStop = false;
    portEXIT_CRITICAL(&lock);
    if (urgent)
        stop("stop", now);
    if (lost && lost == s.owner)
        stop("disconnect", now);
    Command cmd;
    bool replied = xQueueReceive(inbox, &cmd, 0) == pdTRUE;
    Result result;
    if (replied) {
        uint32_t previousDeadline = expires;
        result = urgent ? Result{"STOPPED"} : execute(cmd, now);
        if (result.error && s.owner)
            expires = previousDeadline;
    }
    const auto &cal = s.cal ? s.draft : s.saved;
    rates.update(f);
    s.odom.update(s.saved, f);
    s.rateAt = rates.at;
    s.rateInterval = rates.interval;
    if (s.running) {
        s.goal.measure(cal, f);
        bool reached = true;
        for (int i = 0; i < 2; i++) {
            float error = s.goal.target[i] - s.goal.actual[i];
            if (error * s.goal.target[i] > 0 && std::abs(error) > s.goal.tolerance)
                reached = false;
        }
        if (reached && !braking) {
            braking = true;
            finishAt = now;
        }
        for (int i = 0; i < 2; i++)
            s.wheelSpeed[i] = braking || (s.goal.target[i] - s.goal.actual[i]) * s.goal.target[i] <= 0
                                  ? 0
                                  : std::lround(s.goal.speed(i));
        if (elapsed(now, goalStart, 120000))
            stop("action_timeout", now, "failed");
        else if (braking && elapsed(now, finishAt, 150) && f.settled(now)) {
            bool keep = trial && s.goal.close();
            if (keep) {
                s.draft.checks |= history[(cursor - 1) % 16].turn ? 2u : 1u;
                s.running = false;
                s.actionState = "completed";
                braking = false;
                trial = false;
                portENTER_CRITICAL(&lock);
                auto &record = history[(cursor - 1) % 16];
                record.state = "completed";
                record.reason = "target";
                record.goal = s.goal;
                portEXIT_CRITICAL(&lock);
            } else
                stop(s.goal.close() ? "target" : "overshoot", now, s.goal.close() ? "completed" : "failed");
        }
    }
    const bool basic = s.manualDir[0] || s.manualDir[1];
    const bool raw = basic && (requestedTicks || !cal.distanceReady());
    const int basicRate = requestedTicks ? requestedTicks : board::basicTicksPerSecond;
    const bool manualSpeed = !basic && !s.running && !s.cal && s.owner &&
                             (s.wheelSpeed[0] || s.wheelSpeed[1]);
    const bool wheelRateLoop = (raw && requestedTicks) || manualSpeed;
    const bool responsive = wheelRateLoop && responsiveDrive;
    const int outputLimit = wheelRateLoop ? board::driverPwmRange : (basic ? board::manualPwm : 650);
    float demand[2];
    float unitsPerTick[2];
    for (int i = 0; i < 2; ++i) {
        unitsPerTick[i] = raw ? 1.f : cal.scale[i];
        demand[i] = basic ? s.manualDir[i] * (raw ? basicRate : board::referenceMmPerSecond)
                          : s.wheelSpeed[i];
        s.measuredTicks[i] = rates.ticksPerSecond[cal.physical(i)] * cal.encoderSign[i];
    }
    // Keep feedback gains independent of the slider. A larger reference
    // reduces the PWM jump from one quantized speed sample in raw mode.

    float dt = std::min(uint32_t(now - lastStep), uint32_t(20)) * 0.001f;
    lastStep = now;
    int straight = !s.running && demand[0] && demand[0] == demand[1] ? (demand[0] > 0 ? 1 : -1) : 0;
    if (straight && straight != straightDirection) {
        straightTrim = {};
        for (int i = 0; i < 2; ++i) straightStart[i] = f.ticks[cal.physical(i)];
    }
    const float cruiseScale = manualSpeed ? std::min(cal.scale[0], cal.scale[1]) : 1.f;
    const float requestedRate = std::abs(demand[0]) / cruiseScale;
    bool highCruise = wheelRateLoop && straight && requestedRate > StraightCruise::entry;
    if (!highCruise || straightDirection != straight) straightCruise = {};
    int commonTicks = 0;
    if (highCruise) {
        float slowWheel = std::min(s.measuredTicks[0] * unitsPerTick[0] * straight,
                                   s.measuredTicks[1] * unitsPerTick[1] * straight) / cruiseScale;
        int peakPwm = std::max(std::abs(s.pwm[0]), std::abs(s.pwm[1]));
        float common = straightCruise.update(requestedRate, slowWheel, peakPwm, outputLimit, dt, responsive);
        demand[0] = demand[1] = straight * common * cruiseScale;
        commonTicks = std::lround(common);
    }
    straightDirection = straight;
    if (straight) {
        float travel[2];
        for (int i = 0; i < 2; ++i)
            travel[i] = (f.ticks[cal.physical(i)] - straightStart[i]) * cal.encoderSign[i] * unitsPerTick[i];
        float correction = straightTrim.update((travel[0] - travel[1]) * straight,
                                               std::abs(demand[0]), raw ? 4.f : 1.f, dt);
        if (correction > 0) demand[0] -= straight * correction;
        else demand[1] += straight * correction;
    }
    int out[2]{};
    for (int i = 0; i < 2; ++i) {
        float baseRate = (raw || manualSpeed) ? board::defaultBasicTicks * unitsPerTick[i] : board::referenceMmPerSecond;
        float measured = s.measuredTicks[i] * unitsPerTick[i] / baseRate;
        float target = s.owner ? demand[i] / baseRate : 0;
        int power = wheel[i].step(target, measured, dt, (responsive ? 480.f : 160.f) / board::referenceMmPerSecond,
                                  outputLimit, raw || manualSpeed);
        if (!target || measured * wheel[i].reference > 0 || (!s.running && std::abs(wheel[i].reference) < 0.1f))
            lastProgress[i] = now;
        // Near the goal a small speed demand can leave both motors below breakaway PWM.
        // Raise the floor only while this wheel is commanded and its encoder is stationary.
        if (s.running && target && measured == 0 && wheel[i].reference * target > 0) {
            uint32_t stationaryMs = now - lastProgress[i];
            if (stationaryMs > 100) {
                int floorPwm = std::min<uint32_t>(400, stationaryMs - 100);
                power = target > 0 ? std::max(power, floorPwm) : std::min(power, -floorPwm);
            }
        }
        if (elapsed(now, lastProgress[i], 700)) {
            stop("wheel_stalled", now, "failed");
            out[0] = out[1] = 0;
            break;
        }
        s.referenceTicks[i] = unitsPerTick[i] > 0 ? wheel[i].reference * baseRate / unitsPerTick[i] : 0;
        out[cal.physical(i)] = power * cal.motorSign[i];
    }
    if (s.cal && jogEnd && future(jogEnd, now)) {
        out[0] = jog[0];
        out[1] = jog[1];
    } else
        jogEnd = 0;
    // Unmapped calibration jogs have unknown swept direction: require all sectors.
    int leftDemand = s.wheelSpeed[0], rightDemand = s.wheelSpeed[1];
    if (s.manualDir[0] || s.manualDir[1]) {
        leftDemand = s.manualDir[0];
        rightDemand = s.manualDir[1];
    }
    if (jogEnd) {
        leftDemand = -1;
        rightDemand = 1;
    }
    if (!s.lidar.permits(leftDemand, rightDemand, now) ||
        !s.lidar.permits(std::lround(s.referenceTicks[0]), std::lround(s.referenceTicks[1]), now)) {
        stop("lidar_interlock", now, "failed");
        out[0] = out[1] = 0;
    }
    if (!motor.output(out[0], out[1], now))
        stop("UART_TX", now, "failed");
    for (int i = 0; i < 2; ++i) s.pwm[i] = motor.transmittedPwm(cal.physical(i));
    DriveSample row{};
    row.ms = now;
    row.feedbackAge = now - f.last;
    row.batteryMv = s.battery.fresh(now) ? std::lround(s.battery.volts * 1000) : 0;
    row.responsive = responsive;
    row.cruiseLimit = commonTicks;
    row.pwmLimit = outputLimit;
    bool moving = false;
    for (int i = 0; i < 2; ++i) {
        float request = basic ? s.manualDir[i] * (raw ? basicRate : board::referenceMmPerSecond) : s.wheelSpeed[i];
        row.requested[i] = unitsPerTick[i] > 0 ? std::lround(request / unitsPerTick[i]) : 0;
        row.target[i] = std::lround(s.referenceTicks[i]);
        row.measured[i] = std::lround(s.measuredTicks[i]);
        row.pwm[i] = s.pwm[i];
        moving |= row.requested[i] != 0;
    }
    recordDriveSample(row, moving, !s.owner, s.reason);
    static uint32_t lastBatteryQuery = 0;
    if (elapsed(now, lastBatteryQuery, 1000)) {
        motor.requestBattery();
        lastBatteryQuery = now;
    }
    bool written;
    if (saving && xQueueReceive(saveDone, &written, 0) == pdTRUE) {
        if (written)
            s.saved = pendingSave;
        saving = false;
        s.reason = written ? "saved" : "save_failed";
    }
    publish();
    if (replied)
        xQueueSend(replies, &result, 0);
    if (urgent) {
        Result ack{strcmp(s.reason, "UART_TX") == 0 ? "UART_TX" : nullptr};
        xQueueSend(stopReplies, &ack, 0);
    }
}
void notifyControl(void *) { xTaskNotifyGive(runner); }
void receiveFeedback(void *) {
    uint32_t resets = 0;
    for (;;) {
        uint32_t before = motor.feedback.sequence;
        uint32_t batteryBefore = motor.battery.last;
        bool good = motor.read(millis());
        if (!good)
            ++resets;
        if (!good || before != motor.feedback.sequence || batteryBefore != motor.battery.last) {
            FeedbackSample sample = {motor.feedback, resets, motor.battery};
            xQueueOverwrite(feedbackQueue, &sample);
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }
}
void run(void *) {
    runner = xTaskGetCurrentTaskHandle();
    motor.begin();
    stop("startup", millis());
    if (xTaskCreatePinnedToCore(receiveFeedback, "wheel-rx", 4096, nullptr, 7, nullptr, 1) != pdPASS)
        abort();
    esp_timer_create_args_t args{};
    args.callback = notifyControl;
    args.name = "motor-cycle";
    ESP_ERROR_CHECK(esp_timer_create(&args, &periodic));
    args.name = "motor-expiry";
    ESP_ERROR_CHECK(esp_timer_create(&args, &leaseTimer));
    constexpr int64_t periodUs = 10000;
    int64_t nextCycle = esp_timer_get_time() + periodUs;
    ESP_ERROR_CHECK(esp_timer_start_periodic(periodic, periodUs));
    uint32_t armed = 0;
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        int64_t begin = esp_timer_get_time();
        if (begin >= nextCycle) {
            uint32_t late = uint32_t(begin - nextCycle);
            s.maxWakeUs = std::max(s.maxWakeUs, late);
            if (late >= periodUs) {
                ++s.overruns;
                if (s.owner)
                    stop("deadline", millis(), "failed");
            }
            nextCycle += (1 + late / periodUs) * periodUs;
        }
        tick(millis());
        if (!s.owner || expires != armed) {
            if (esp_timer_is_active(leaseTimer))
                esp_timer_stop(leaseTimer);
            armed = s.owner ? expires : 0;
            if (s.owner) {
                int32_t remaining = int32_t(expires - millis());
                ESP_ERROR_CHECK(esp_timer_start_once(leaseTimer, std::max(1, int(remaining)) * 1000));
            }
        }
        s.maxLoopUs = std::max(s.maxLoopUs, uint32_t(esp_timer_get_time() - begin));
    }
}
void saveWorker(void *) {
    Calibration c;
    for (;;)
        if (xQueueReceive(saveJobs, &c, portMAX_DELAY)) {
            bool ok = storedCalibration(c, true);
            xQueueSend(saveDone, &ok, portMAX_DELAY);
        }
}
} // namespace
void startController(LidarSource *lidar, LidarState config) {
    s.lidar = config;
    s.lidar.installed = lidar != nullptr;
    if (lidar) {
        scanQueue = xQueueCreate(1, sizeof(ScanSummary));
        if (!scanQueue)
            abort();
        const auto sampler = [](void *arg) {
            auto *source = static_cast<LidarSource *>(arg);
            for (;;) {
                ScanSummary scan;
                if (source->poll(scan))
                    xQueueOverwrite(scanQueue, &scan);
                vTaskDelay(pdMS_TO_TICKS(2));
            }
        };
        if (xTaskCreatePinnedToCore(sampler, "lidar", 4096, lidar, 2, nullptr, 0) != pdPASS)
            abort();
    }
    if (!storedCalibration(s.saved, false))
        s.saved = Calibration::chassisDefaults();
    s.boot = randId();
    publish();
    feedbackQueue = xQueueCreate(1, sizeof(FeedbackSample));
    inbox = xQueueCreate(1, sizeof(Command));
    replies = xQueueCreate(1, sizeof(Result));
    stopReplies = xQueueCreate(1, sizeof(Result));
    saveJobs = xQueueCreate(1, sizeof(Calibration));
    saveDone = xQueueCreate(1, sizeof(bool));
    if (!inbox || !replies || !stopReplies || !feedbackQueue || !saveJobs || !saveDone)
        abort();
    if (xTaskCreatePinnedToCore(saveWorker, "cal-save", 4096, nullptr, 2, nullptr, 0) != pdPASS)
        abort();
    if (xTaskCreatePinnedToCore(run, "wheel-control", 8192, nullptr, 8, &runner, 1) != pdPASS)
        abort();
}
Snapshot snapshot() {
    portENTER_CRITICAL(&lock);
    Snapshot v = published;
    portEXIT_CRITICAL(&lock);
    return v;
}
Result submit(const Command &c) {
    Result r;
    if (c.op == Op::Stop) {
        portENTER_CRITICAL(&lock);
        urgentStop = true;
        portEXIT_CRITICAL(&lock);
        xTaskNotifyGive(runner);
        xQueueReceive(stopReplies, &r, portMAX_DELAY);
        return r;
    }
    if (!xQueueSend(inbox, &c, 0))
        return {"BUSY"};
    xTaskNotifyGive(runner);
    xQueueReceive(replies, &r, portMAX_DELAY);
    return r;
}
void stopSession(uint32_t session) {
    portENTER_CRITICAL(&lock);
    if (published.owner == session)
        gone = session;
    portEXIT_CRITICAL(&lock);
    xTaskNotifyGive(runner);
}
bool lookupAction(const char *key, ActionRecord &record) {
    bool found = false;
    portENTER_CRITICAL(&lock);
    for (const auto &h : history)
        if (h.id && strcmp(h.key, key) == 0) {
            record = h;
            if (published.action == h.id && published.running)
                record.goal = published.goal;
            found = true;
            break;
        }
    portEXIT_CRITICAL(&lock);
    return found;
}

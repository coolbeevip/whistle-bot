// SPDX-License-Identifier: Apache-2.0
#include "drive_log.h"
#include <LittleFS.h>
#include <esp_partition.h>
#include <atomic>
#include <algorithm>

namespace {
// The control task owns the ring until it hands a completed run to the writer.
constexpr unsigned capacity = 400, keep = 24;
DriveSample samples[capacity];
unsigned nextRow, rows, total;
uint32_t sampleAt;
char endReason[40];
std::atomic<bool> ready{false}, writing{false}, saveError{false};
TaskHandle_t writer;
SemaphoreHandle_t files;
uint32_t newest;

String path(uint32_t id) { return String("/drive-") + id + ".csv"; }

bool emptyPartition() {
    auto part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "spiffs");
    if (!part) return false;
    uint32_t block[128];
    for (size_t at = 0; at < part->size; at += sizeof(block)) {
        if (esp_partition_read(part, at, block, sizeof(block)) != ESP_OK ||
            !std::all_of(block, block + 128, [](uint32_t v){ return v == UINT32_MAX; })) return false;
    }
    return true;
}
bool save() {
    uint32_t id = newest + 1;
    auto f = LittleFS.open("/drive.tmp", "w");
    if (!f) return false;
    auto print = [&](const char *fmt, auto... args) {
        char line[240];
        int len = snprintf(line, sizeof(line), fmt, args...);
        return len > 0 && size_t(len) < sizeof(line) &&
               f.write(reinterpret_cast<uint8_t *>(line), len) == size_t(len);
    };
    bool ok = print("# run=%lu,total_samples=%u,stop=%s\n", (unsigned long)id, total, endReason) &&
        print("ms,request_l_ticks_s,request_r_ticks_s,target_l_ticks_s,target_r_ticks_s,measured_l_ticks_s,measured_r_ticks_s,pwm_l,pwm_r,pwm_limit,battery_mv,feedback_age_ms,cruise_limit_ticks_s,responsive\n");
    for (unsigned i = 0; ok && i < rows; ++i) {
        const auto &v = samples[(nextRow + capacity - rows + i) % capacity];
        ok = print("%lu,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%lu,%d,%d\n",(unsigned long)v.ms,
                   v.requested[0],v.requested[1],v.target[0],v.target[1],v.measured[0],v.measured[1],
                   v.pwm[0],v.pwm[1],v.pwmLimit,v.batteryMv,(unsigned long)v.feedbackAge,v.cruiseLimit,int(v.responsive));
    }
    f.flush();
    ok = ok && !f.getWriteError();
    f.close();
    if (!ok || !LittleFS.rename("/drive.tmp",path(id))) return false;
    newest = id;
    if (id > keep) LittleFS.remove(path(id - keep));
    return true;
}
void worker(void *) {
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        xSemaphoreTake(files, portMAX_DELAY);
        saveError = !save();
        xSemaphoreGive(files);
        nextRow = rows = total = 0;
        writing = false;
    }
}
}
void startDriveLog() {
    if (!LittleFS.begin() && !(emptyPartition() && LittleFS.begin(true))) return;
    auto dir = LittleFS.open("/");
    for (auto f = dir.openNextFile(); f; f = dir.openNextFile()) {
        unsigned long id;
        int end = 0;
        if (sscanf(f.name(),"drive-%lu.csv%n",&id,&end) == 1 && end && !f.name()[end])
            newest = std::max(newest, uint32_t(id));
    }
    files = xSemaphoreCreateMutex();
    ready = files && xTaskCreatePinnedToCore(worker, "drive-log", 6144, nullptr, 1, &writer, 0) == pdPASS;
}
bool driveLogSaving() { return writing.load(); }
void recordDriveSample(const DriveSample &v, bool moving, bool released, const char *reason) {
    if (!ready || writing || (!total && !moving)) return;
    if (!total || released || uint32_t(v.ms - sampleAt) >= 100) {
        samples[nextRow] = v;
        nextRow = (nextRow + 1) % capacity;
        rows = std::min(capacity, rows + 1);
        ++total;
        sampleAt = v.ms;
    }
    if (!released) return;
    strlcpy(endReason, reason, sizeof(endReason));
    writing = true;
    xTaskNotifyGive(writer);
}
const char *driveLogRead(JsonDocument &q, JsonDocument &r) {
    if (!ready) return "LOG_STORAGE";
    if (!xSemaphoreTake(files, 0)) return "LOG_BUSY";
    const char *error = nullptr;
    r["latest"] = newest;
    r["saving"] = writing.load();
    r["write_failed"] = saveError.load();
    if (!q["run"].isNull()) {
        uint32_t id = q["run"] | 0u;
        uint32_t offset = q["offset"] | 0u;
        if (!id || id > newest || newest-id >= keep) error = "NO_RUN";
        else {
            auto f = LittleFS.open(path(id), "r");
            if (!f || offset > f.size() || !f.seek(offset)) error = "LOG_READ";
            else {
                char buf[769];
                size_t expected = std::min<size_t>(768, f.size() - offset);
                size_t n = f.readBytes(buf, expected);
                buf[n] = 0;
                if (n != expected) error = "LOG_READ";
                else {
                    r["csv"] = String(buf);
                    r["next"] = offset + n;
                    r["eof"] = offset + n == f.size();
                }
            }
        }
    }
    xSemaphoreGive(files);
    return error;
}

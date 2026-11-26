// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

class String : public std::string {
public:
    using std::string::string;
    using std::string::append;
    String &append(const char *value) { std::string::append(value); return *this; }
    bool startsWith(const char *prefix) const { return find(prefix) == 0; }
};

inline uint32_t hostTime = 1000;
inline uint32_t millis() { return hostTime; }

#if !defined(__APPLE__)
#define strlcpy hostStrlcpy
inline size_t hostStrlcpy(char *dest, const char *src, size_t size) {
    size_t n = std::strlen(src);
    if (size) {
        size_t copied = n < size ? n : size - 1;
        std::memcpy(dest, src, copied);
        dest[copied] = 0;
    }
    return n;
}
#endif

struct HostQueue {
    std::vector<unsigned char> data;
    bool full = false;
    explicit HostQueue(size_t size) : data(size) {}
};
using QueueHandle_t = HostQueue *;
inline int xQueueSend(HostQueue *queue, const void *data, unsigned) {
    if (queue->full) return 0;
    std::memcpy(queue->data.data(), data, queue->data.size());
    queue->full = true;
    return 1;
}
inline int xQueueReceive(HostQueue *queue, void *data, unsigned) {
    if (!queue || !queue->full) return 0;
    std::memcpy(data, queue->data.data(), queue->data.size());
    queue->full = false;
    return 1;
}
using TaskHandle_t = void *;
using portMUX_TYPE = int;
constexpr int pdTRUE = 1, pdPASS = 1, portMUX_INITIALIZER_UNLOCKED = 0;
constexpr unsigned portMAX_DELAY = UINT32_MAX;
inline void portENTER_CRITICAL(int *) {}
inline void portEXIT_CRITICAL(int *) {}
void xTaskNotifyGive(TaskHandle_t);
QueueHandle_t xQueueCreate(unsigned, size_t);
void xQueueOverwrite(QueueHandle_t, const void *);
void vTaskDelay(unsigned);
unsigned pdMS_TO_TICKS(unsigned);
TaskHandle_t xTaskGetCurrentTaskHandle();
int xTaskCreatePinnedToCore(void (*)(void *), const char *, unsigned, void *, unsigned, TaskHandle_t *, int);
void ulTaskNotifyTake(int, unsigned);

// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cstdint>
#include <string>

// UART test double. Only placed on the include path of the host driver test.
constexpr int SERIAL_8N1 = 0;
struct MemorySerial {
    std::string input, output;
    size_t next = 0;
    int freeBytes = 128;
    void begin(unsigned, int, int, int) {}
    void setRxBufferSize(size_t) {}
    void setTxBufferSize(size_t) {}
    int availableForWrite() { return freeBytes; }
    void print(const char *s) { output += s; }
    size_t write(const uint8_t *s, size_t n) {
        output.append(reinterpret_cast<const char *>(s), n);
        return n;
    }
    int available() { return static_cast<int>(input.size() - next); }
    int read() { return input.at(next++); }
};
inline MemorySerial Serial1;

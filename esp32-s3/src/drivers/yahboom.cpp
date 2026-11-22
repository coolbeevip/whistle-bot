// SPDX-License-Identifier: Apache-2.0
#include "yahboom.h"
#include <cstdio>
void Yahboom::begin() {
    Serial1.setRxBufferSize(2048);
    Serial1.setTxBufferSize(0);
    Serial1.begin(board::baud, SERIAL_8N1, board::rx, board::tx);
}
void Yahboom::requestFeedback() {
    const char query[] = "$upload:1,0,0#";
    if (Serial1.availableForWrite() >= int(sizeof(query) - 1))
        Serial1.print(query);
}
void Yahboom::requestBattery() {
    const char query[] = "$read_vol#";
    if (Serial1.availableForWrite() >= int(sizeof(query) - 1))
        Serial1.print(query);
}
bool Yahboom::read(uint32_t now) {
    bool ok = true;
    for (int budget = 0; budget < 512 && Serial1.available(); budget++) {
        char ch = Serial1.read();
        if (ch == '$') {
            used = 0;
            discard = false;
        }
        if (ch == '#' && !discard) {
            line[used] = 0;
            long a, b, c, d;
            char extra;
            if (sscanf(line, "$MAll:%ld,%ld,%ld,%ld%c", &a, &b, &c, &d, &extra) == 4 ||
                sscanf(line, "$MALL:%ld,%ld,%ld,%ld%c", &a, &b, &c, &d, &extra) == 4)
                ok = feedback.update(c, d, now) && ok;
            else {
                float volts;
                int end = -1;
                if (sscanf(line, "$Battery:%fV%n", &volts, &end) == 1 && end >= 0 && line[end] == 0)
                    battery.update(volts, now);
            }
            discard = true;
            used = 0;
        } else if (!discard && used < sizeof(line) - 1)
            line[used++] = ch;
        else
            discard = true;
    }
    return ok;
}
bool Yahboom::output(int m3, int m4, uint32_t now, bool force) {
    if (!force && m3 == prior[0] && m4 == prior[1] && !elapsed(now, sentAt, 100))
        return true;
    // Keep at most one nonzero motion frame in flight, including under host floods.
    if (!force && (m3 || m4) && !elapsed(now, sentAt, 10))
        return true;
    char frame[32];
    int n = snprintf(frame, sizeof(frame), "$pwm:0,0,%d,%d#", m3, m4);
    if (Serial1.availableForWrite() < n || Serial1.write((uint8_t *)frame, n) != size_t(n))
        return false;
    prior[0] = m3;
    prior[1] = m4;
    sentAt = now;
    return true;
}

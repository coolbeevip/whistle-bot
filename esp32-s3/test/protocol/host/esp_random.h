// SPDX-License-Identifier: Apache-2.0
#pragma once
inline uint32_t esp_random() {
    static uint32_t seed = 41;
    return seed += 8;
}

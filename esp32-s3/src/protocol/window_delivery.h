// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cstdint>

struct ControlWindow {
    uint32_t lease = 0, id = 0, opened = 0;
};

// One cursor per session. A failed enqueue leaves the current window eligible
// for another attempt. A newer controller window automatically supersedes it.
struct WindowDelivery {
    uint32_t lease = 0, id = 0;
    bool pending(ControlWindow window) const {
        return window.id && (window.lease != lease || window.id != id);
    }
    void finish(ControlWindow window, bool queued) {
        if (queued && window.id) {
            lease = window.lease;
            id = window.id;
        }
    }
};

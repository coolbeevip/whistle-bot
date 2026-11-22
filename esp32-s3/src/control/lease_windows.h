// SPDX-License-Identifier: Apache-2.0
#pragma once
#include "../board/config.h"

class LeaseWindows {
    struct Entry { uint32_t id = 0, opened = 0; };
    static constexpr unsigned capacity = (board::padLeaseMs + board::windowMs - 1) / board::windowMs;
    Entry recent[capacity]{};
public:
    void add(uint32_t id, uint32_t now) {
        for (unsigned i = capacity - 1; i > 0; --i) recent[i] = recent[i-1];
        recent[0] = {id, now};
    }

    bool renew(uint32_t id, bool pad, uint32_t now, uint32_t &expires) const {
        if (!id || int32_t(expires - now) <= 0) return false;
        uint32_t limit = pad ? board::padLeaseMs : board::leaseMs;
        for (unsigned i = 0; i < (pad ? capacity : 2u); ++i) {
            if (recent[i].id != id) continue;
            if (uint32_t(now - recent[i].opened) >= limit) return false;
            uint32_t deadline = recent[i].opened + limit;
            // A delayed command must not replace a newer accepted pad command.
            if (pad && int32_t(deadline - expires) < 0) return false;
            expires = deadline;
            return true;
        }
        return false;
    }
};

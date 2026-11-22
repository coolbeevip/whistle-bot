// SPDX-License-Identifier: Apache-2.0
#include "../src/protocol/window_delivery.h"
#include "../src/control/lease_windows.h"
#include <cassert>
#include <initializer_list>

int main() {
    WindowDelivery cursor;
    ControlWindow first{7, 41, 100}, next{7, 42, 200}, reclaimed{9, 43, 400};
    assert(cursor.pending(first));
    cursor.finish(first, false); // transport queue full
    assert(cursor.pending(first));
    cursor.finish(first, true);
    assert(!cursor.pending(first));
    assert(cursor.pending(next));
    cursor.finish(next, false);
    // Once the controller rotates again, send its latest window on retry.
    ControlWindow latest{7, 43, 300};
    assert(cursor.pending(latest));
    cursor.finish(latest, true);
    assert(!cursor.pending(latest));
    assert(cursor.pending(reclaimed)); // different lease, even with the same window ID
    assert(!cursor.pending({}));

    for (uint32_t start : {1000u, UINT32_MAX - 250u}) {
        LeaseWindows history;
        uint32_t deadline = start + 450;
        for (unsigned i = 0; i < 5; ++i) history.add(i + 1, start + 100*i);
        assert(history.renew(1, true, start + 449, deadline));
        assert(deadline == start + 450); // replay does not buy more time
        assert(!history.renew(1, true, start + 450, deadline));
        assert(history.renew(3, true, start + 449, deadline));
        assert(deadline == start + 650);
        assert(!history.renew(2, true, start + 449, deadline));
        assert(!history.renew(5, true, start + 650, deadline)); // expired lease
        uint32_t standard = start + 550;
        assert(!history.renew(3, false, start + 449, standard));
        assert(history.renew(4, false, start + 449, standard));
        assert(standard == start + 600);
    }
}

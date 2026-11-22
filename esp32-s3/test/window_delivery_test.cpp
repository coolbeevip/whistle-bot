// SPDX-License-Identifier: Apache-2.0
#include "../src/protocol/window_delivery.h"
#include <cassert>

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
}

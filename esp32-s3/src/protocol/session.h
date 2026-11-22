// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <ArduinoJson.h>
#include "window_delivery.h"
#include "../runtime/controller.h"

struct Session {
    uint32_t sid = 0, lastId = 0, telemetryAt = 0, lastOwner = UINT32_MAX, lastAction = 0;
    const char *lastReason = nullptr, *lastActionState = nullptr;
    bool wasOnline = false;
    unsigned hz = 0, lidarHz = 0;
    uint32_t lidarAt = 0;
    WindowDelivery windows;
    String previous, reply;
};
String handleFrame(Session &s, const String &wire, uint32_t receivedAt, bool usb = false, bool setupHotspot = false);
String eventFrame(Session &s, uint32_t now, ControlWindow &window);

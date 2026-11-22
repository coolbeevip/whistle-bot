// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <ArduinoJson.h>
#include <IPAddress.h>

void startNetwork(const char *hotspotName, const char *hotspotPassword, void (*stopMotion)());
const char *networkCommand(const String &op, JsonDocument &request, JsonDocument &reply, bool localSetup);
bool consoleOrigin(const String &origin);

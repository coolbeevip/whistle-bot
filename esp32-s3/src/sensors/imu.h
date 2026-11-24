// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <ArduinoJson.h>
#include "../control/heading.h"
Heading imuHeading();

void startImu();
const char *probeImu(JsonDocument &reply);
void describeImu(JsonDocument &reply);

// SPDX-License-Identifier: Apache-2.0
#include "runtime/controller.h"
#include "transport/host.h"
#include "sensors/imu.h"
#include "storage/drive_log.h"

void setup() {
    startController();
    startDriveLog();
    startImu();
    startHosts();
}
void loop() { serviceHosts(); }

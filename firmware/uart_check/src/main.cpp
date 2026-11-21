// SPDX-License-Identifier: Apache-2.0
#include <Arduino.h>

void setup() {
    Serial.begin(115200);
    Serial1.begin(115200, SERIAL_8N1, 18, 17);
}

void loop() {
    static unsigned long lastQuery = 0;
    if (millis() - lastQuery >= 3000) {
        lastQuery = millis();
        Serial.println("UART1 query");
        Serial1.print("$read_flash#");
    }
    while (Serial1.available()) {
        Serial.write(Serial1.read());
    }
    delay(1);
}

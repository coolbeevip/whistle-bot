// SPDX-License-Identifier: Apache-2.0
#include "../../src/runtime/controller.cpp"
#include "../../src/protocol/session.h"
#include <iostream>

void xTaskNotifyGive(TaskHandle_t) { tick(millis()); }
Heading imuHeading() { return {0, 0, millis(), true}; }
bool driveLogSaving() { return false; }
void recordDriveSample(const DriveSample &, bool, bool, const char *) {}
void describeImu(JsonDocument &) {}
const char *probeImu(JsonDocument &) { std::abort(); }
const char *driveLogRead(JsonDocument &, JsonDocument &) { std::abort(); }
const char *networkCommand(const String &, JsonDocument &, JsonDocument &, bool) { std::abort(); }

int main() {
    HostQueue commands(sizeof(Command)), responses(sizeof(Result)), stops(sizeof(Result));
    inbox = &commands;
    replies = &responses;
    stopReplies = &stops;
    s.saved = Calibration::chassisDefaults();
    s.saved.scale[0] = s.saved.scale[1] = 0.12f;
    s.saved.checks = 1;
    s.boot = randId();
    observed.update(0, 0, millis() - 200);
    observed.update(0, 0, millis());
    tick(millis());
    Session clients[2];
    std::string line;
    while (std::getline(std::cin, line)) {
        JsonDocument input, result;
        if (deserializeJson(input, line)) return 1;
        auto &client = clients[input["client"].as<unsigned>() == 1 ? 1 : 0];
        if (input["frame"].is<JsonObject>()) {
            String wire;
            serializeJson(input["frame"], wire);
            JsonDocument reply;
            if (deserializeJson(reply, handleFrame(client, wire, millis(), false))) return 1;
            result["reply"] = reply;
        } else {
            unsigned remaining = input["advance"].as<unsigned>();
            while (remaining) {
                const unsigned step = std::min(10u, remaining);
                remaining -= step;
                hostTime += step;
                observed.update(0, 0, millis());
                tick(millis());
            }
        }
        auto events = result["events"].to<JsonArray>();
        for (;;) {
            ControlWindow window;
            auto event = eventFrame(client, millis(), window);
            if (event.empty()) break;
            JsonDocument packet;
            if (deserializeJson(packet, event)) return 1;
            events.add(packet);
            client.windows.finish(window, true);
        }
        result["starts"] = nextAction;
        serializeJson(result, std::cout);
        std::cout << std::endl;
    }
}

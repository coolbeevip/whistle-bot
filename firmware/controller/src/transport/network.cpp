// SPDX-License-Identifier: Apache-2.0
#include "network.h"
#include "../runtime/controller.h"
#include <WiFi.h>
#include <Preferences.h>
#include <esp_wifi.h>

namespace {
constexpr uint8_t bootPin = 0, ledPin = 38;
const IPAddress hotspotIp(192, 168, 4, 1);
struct Profile { char ssid[33]{}, pass[65]{}; };
enum class Job { Scan, Test, Forget };
struct Request { Job job; Profile profile; };
struct NetworkState {
    bool testing = false, connected = false, ap = false, scanning = false, working = false;
    String savedName, address, message;
    String networks[16];
    const char *scanState = "idle";
    unsigned count = 0;
};
NetworkState live, published;
QueueHandle_t requests;
SemaphoreHandle_t stateLock;
const char *apName, *apPassword;
void (*halt)();
Profile saved, candidate;
bool attempting = false, forced = false;
uint32_t attemptAt, retryAt, onlineAt, errorAt;
bool showError = false;
Preferences prefs;
bool startAp() {
    if (live.ap) return true;
    live.ap = WiFi.softAPConfig(hotspotIp, hotspotIp, IPAddress(255,255,255,0)) &&
              WiFi.softAP(apName, apPassword);
    return live.ap;
}
void join(const Profile &p, bool test) {
    WiFi.disconnect(false, false);
    WiFi.begin(p.ssid, p.pass[0] ? p.pass : nullptr);
    attemptAt = millis();
    attempting = true;
    live.connected = false;
    live.address = "";
    live.testing = test;
}
void announceError(const char *message) {
    live.message = message;
    showError = true;
    errorAt = millis();
}
void cancelScan() {
    if (live.scanning) { esp_wifi_scan_stop(); live.scanState = "idle"; }
    WiFi.scanDelete();
    live.scanning = false;
}
void recover(bool forget) {
    halt();
    cancelScan();
    forced = true;
    attempting = live.testing = live.connected = false;
    candidate = {};
    WiFi.disconnect(false, false);
    live.address = "";
    startAp();
    live.message = "Hotspot enabled. Saved Wi-Fi settings are retained.";
    if (forget) {
        if (!prefs.isKey("station") || prefs.remove("station")) {
            saved = {};
            live.savedName = "";
            live.message = "Home network forgotten.";
        } else announceError("Could not erase the saved network.");
    }
}
void handleRequest(const Request &r) {
    if (snapshot().owner) { live.message = "Stop driving or finish calibration first."; return; }
    if (r.job == Job::Forget) { recover(true); return; }
    if (r.job == Job::Scan) {
        live.count = 0;
        WiFi.scanDelete();
        live.scanning = WiFi.scanNetworks(true, false, false, 120) == WIFI_SCAN_RUNNING;
        live.scanState = live.scanning ? "running" : "failed";
        live.message = "";
        return;
    }
    if (!startAp()) { announceError("Could not start the setup hotspot."); return; }
    cancelScan();
    candidate = r.profile;
    forced = false;
    live.message = "Testing the home network…";
    join(candidate, true);
}
void updateLink(uint32_t now) {
    if (live.scanning) {
        int count = WiFi.scanComplete();
        if (count != WIFI_SCAN_RUNNING) {
            for (int i = 0; i < count && live.count < 16; ++i) {
                String name = WiFi.SSID(i);
                bool duplicate = false;
                for (unsigned j = 0; j < live.count; ++j) duplicate |= live.networks[j] == name;
                if (name.length() && !duplicate) live.networks[live.count++] = name;
            }
            WiFi.scanDelete();
            live.scanning = false;
            live.scanState = count < 0 ? "failed" : "done";
        }
    }
    if (attempting) {
        const Profile &target = live.testing ? candidate : saved;
        if (WiFi.status() == WL_CONNECTED && WiFi.localIP() != IPAddress() && WiFi.SSID() == target.ssid) {
            if (live.testing && prefs.putBytes("station", &candidate, sizeof(candidate)) != sizeof(candidate)) {
                recover(false);
                announceError("Could not save credentials. Previous settings retained.");
                return;
            }
            if (live.testing) {
                saved = candidate;
                live.savedName = saved.ssid;
                live.message = "Connected and saved.";
            }
            candidate = {};
            live.connected = true;
            live.testing = attempting = false;
            onlineAt = now;
        } else if (uint32_t(now - attemptAt) >= 20000) {
            if (live.testing) announceError("Connection failed. Check the name and password. Previous settings retained.");
            WiFi.disconnect(false, false);
            candidate = {};
            attempting = live.testing = false;
            retryAt = now;
            startAp();
        }
    } else if (live.connected && WiFi.status() != WL_CONNECTED) {
        live.connected = false;
        live.address = "";
        retryAt = now;
        startAp();
    } else if (!live.connected && !forced && !live.scanning && saved.ssid[0] &&
               uint32_t(now - retryAt) >= 30000 && !snapshot().owner) {
        join(saved, false);
    }
    if (live.connected) {
        live.address = WiFi.localIP().toString();
        if (live.ap && uint32_t(now - onlineAt) >= 60000 && !WiFi.softAPgetStationNum() && !snapshot().owner)
            if (WiFi.softAPdisconnect(true)) live.ap = false;
    } else if (!live.ap) startAp();
}
void indicator(uint32_t now, bool holding) {
    if (showError && uint32_t(now - errorAt) >= 3000) showError = false;
    uint32_t rgb;
    if (holding) rgb = (now / 150) % 2 ? 0x180020 : 0;
    else if (showError) rgb = (now / 250) % 2 ? 0x250000 : 0;
    else if (attempting || live.scanning) rgb = (now / 400) % 2 ? 0x201000 : 0;
    else if (live.connected) rgb = 0x001900;
    else rgb = live.ap ? 0x000020 : 0;
    static uint32_t previous = UINT32_MAX;
    if (rgb != previous) {
        rgbLedWrite(ledPin, rgb >> 16, (rgb >> 8) & 255, rgb & 255);
        previous = rgb;
    }
}
void networkTask(void *) {
    uint32_t pressedAt = 0;
    bool down = false, handled = false, armed = false;
    for (;;) {
        uint32_t now = millis();
        bool pressed = digitalRead(bootPin) == LOW;
        if (!pressed) { armed = true; down = handled = false; }
        if (pressed && armed && !down) { down = true; pressedAt = now; }
        if (down && !handled && uint32_t(now - pressedAt) >= 5000) {
            handled = true;
            Request discard;
            xQueueReceive(requests, &discard, 0);
            recover(false);
        }
        Request request;
        if (!down && xQueueReceive(requests, &request, 0) == pdTRUE) handleRequest(request);
        // A request may start a timed connection after the button timestamp above.
        updateLink(millis());
        indicator(millis(), down && !handled);
        live.working = attempting || live.scanning;
        xSemaphoreTake(stateLock, portMAX_DELAY);
        published = live;
        xSemaphoreGive(stateLock);
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
} // namespace

void startNetwork(const char *name, const char *pass, void (*stopMotion)()) {
    apName = name;
    apPassword = pass;
    halt = stopMotion;
    requests = xQueueCreate(1, sizeof(Request));
    stateLock = xSemaphoreCreateMutex();
    if (!requests || !stateLock) abort();
    pinMode(bootPin, INPUT_PULLUP);
    prefs.begin("car-network", false);
    if (prefs.getBytesLength("station") == sizeof(saved))
        prefs.getBytes("station", &saved, sizeof(saved));
    saved.ssid[32] = saved.pass[64] = 0;
    live.savedName = saved.ssid;
    WiFi.persistent(false);
    WiFi.mode(WIFI_AP_STA);
    WiFi.setAutoReconnect(false);
    startAp();
    if (saved.ssid[0]) join(saved, false);
    if (xTaskCreate(networkTask, "rover-network", 6144, nullptr, 1, nullptr) != pdPASS) abort();
}

bool consoleOrigin(const String &origin, IPAddress localAddress) {
    return localAddress != IPAddress() && origin == "http://" + localAddress.toString();
}

const char *networkCommand(const String &op, JsonDocument &q, JsonDocument &r, bool localSetup) {
    if (op == "wifi_status") {
        xSemaphoreTake(stateLock, portMAX_DELAY);
        r["hotspot"] = apName;
        r["hotspot_on"] = published.ap;
        r["home_ssid"] = published.savedName;
        r["home_ip"] = published.address;
        r["scan_state"] = published.scanState;
        r["busy"] = published.working;
        r["setup_allowed"] = localSetup;
        r["message"] = published.message;
        auto names = r["networks"].to<JsonArray>();
        for (unsigned i=0; i<published.count; ++i) names.add(published.networks[i]);
        xSemaphoreGive(stateLock);
        return nullptr;
    }
    if (!localSetup) return "HOTSPOT_REQUIRED";
    if (snapshot().owner) return "BUSY";
    Request request{};
    if (op == "wifi_test") {
        request.job = Job::Test;
        JsonString name = q["ssid"].as<JsonString>(), pass = q["password"].as<JsonString>();
        if (name.isNull() || !name.size() || name.size()>32 || pass.isNull() || pass.size()>64 ||
            strlen(name.c_str())!=name.size() || strlen(pass.c_str())!=pass.size()) return "FIELDS";
        strlcpy(request.profile.ssid, name.c_str(), sizeof(request.profile.ssid));
        strlcpy(request.profile.pass, pass.c_str(), sizeof(request.profile.pass));
    } else if (op == "wifi_scan") request.job = Job::Scan;
    else if (op == "wifi_forget") request.job = Job::Forget;
    else return "UNKNOWN_OP";
    xSemaphoreTake(stateLock, portMAX_DELAY);
    bool accepted = !published.working && xQueueSend(requests, &request, 0) == pdTRUE;
    if (accepted) published.working = true;
    xSemaphoreGive(stateLock);
    return accepted ? nullptr : "BUSY";
}

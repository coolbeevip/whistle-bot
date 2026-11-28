// SPDX-License-Identifier: Apache-2.0
#include "host.h"
#include "network.h"
#include "../protocol/session.h"
#include <ESPAsyncWebServer.h>
#include <WiFi.h>
#include <Preferences.h>
#include <esp_random.h>
#if __has_include("wifi_password.local.h")
#include "wifi_password.local.h"
#endif

namespace {
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");
SemaphoreHandle_t guard;
struct Client {
    uint32_t id = 0;
    String frame;
    Session session;
};
Client phone;
Session usb;
String line;
bool discard = false;
uint32_t cleanupAt;
char ssid[24], password[64];

void websocket(AsyncWebSocket *, AsyncWebSocketClient *socket, AwsEventType type, void *arg, uint8_t *data,
               size_t size) {
    if (type != WS_EVT_CONNECT && type != WS_EVT_DISCONNECT && type != WS_EVT_DATA)
        return;
    const uint32_t receivedAt = millis();
    xSemaphoreTake(guard, portMAX_DELAY);
    const bool current = phone.id == socket->id();
    if (type == WS_EVT_CONNECT) {
        if (phone.id)
            socket->client()->setRxTimeout(3);
        else
            phone.id = socket->id();
    } else if (current && type == WS_EVT_DISCONNECT) {
        stopSession(phone.session.sid);
        phone = Client{};
    } else if (!current && type == WS_EVT_DATA) {
        socket->text(String("{\"v\":1,\"event\":\"rover_busy\",\"device_id\":\"") + controllerName() + "\"}");
    } else if (current && type == WS_EVT_DATA) {
        auto *f = static_cast<AwsFrameInfo *>(arg);
        if (f->index == 0 && f->num == 0)
            phone.frame = "";
        if (f->message_opcode != WS_TEXT || f->len > 1024 || phone.frame.length() + size > 1024) {
            stopSession(phone.session.sid);
            socket->close(1009, "frame");
        } else {
            phone.frame.concat(reinterpret_cast<char *>(data), size);
            if (f->final && f->index + size == f->len) {
                String reply = handleFrame(phone.session, phone.frame, receivedAt, false, socket->client()->localIP() == WiFi.softAPIP());
                if (!socket->text(reply)) {
                    stopSession(phone.session.sid);
                    socket->close();
                }
                phone.frame = "";
            }
        }
    }
    xSemaphoreGive(guard);
}
void credentials() {
    Preferences p;
    p.begin("car-network", false);
    String saved = p.getString("pass", "");
#ifdef WHISTLE_WIFI_PASSWORD
    static_assert(sizeof(WHISTLE_WIFI_PASSWORD) >= 9 && sizeof(WHISTLE_WIFI_PASSWORD) <= sizeof(password));
    if (saved != WHISTLE_WIFI_PASSWORD) {
        saved = WHISTLE_WIFI_PASSWORD;
        p.putString("pass", saved);
    }
#endif
    if (saved.length() < 8 || saved.length() >= sizeof(password)) {
        snprintf(password, sizeof(password), "%08lx%08lx", (unsigned long)esp_random(),
                 (unsigned long)esp_random());
        p.putString("pass", password);
    } else
        strlcpy(password, saved.c_str(), sizeof(password));
    snprintf(ssid, sizeof(ssid), "Whistle-%06lX", (unsigned long)(ESP.getEfuseMac() & 0xffffff));
}
} // namespace
void startHosts() {
    Serial.setTxBufferSize(2048);
    Serial.begin(115200);
    guard = xSemaphoreCreateMutex();
    credentials();
    startNetwork(ssid, password, [] {
        xSemaphoreTake(guard, portMAX_DELAY);
        Command stop{};
        stop.op = Op::Stop;
        submit(stop);
        xSemaphoreGive(guard);
    });
    ws.setFilter([](AsyncWebServerRequest *r) {
        return !r->hasHeader("Origin") || consoleOrigin(r->header("Origin"));
    });
    ws.onEvent(websocket);
    server.addHandler(&ws);
    server.begin();
    Serial.printf("{\"event\":\"wifi_setup\",\"ssid\":\"%s\",\"password\":\"%s\"}\n", ssid, password);
}
void serviceHosts() {
    xSemaphoreTake(guard, portMAX_DELAY);
    for (int budget = 0; budget < 256 && Serial.available(); budget++) {
        char ch = Serial.read();
        if (ch == 10) {
            if (!discard && line.length()) {
                String reply = handleFrame(usb, line, millis(), true);
                if (Serial.availableForWrite() >= int(reply.length() + 2))
                    Serial.println(reply);
                else {
                    stopSession(usb.sid);
                    usb = Session{};
                }
            } else if (discard && Serial.availableForWrite() >= 64)
                Serial.println("{\"v\":1,\"ok\":false,\"error\":\"BAD_FRAME\"}");
            line = "";
            discard = false;
        } else if (ch != 13 && !discard) {
            if (line.length() >= 1024)
                discard = true;
            else
                line += ch;
        }
    }
    uint32_t now = millis();
    ControlWindow window;
    String e = eventFrame(usb, now, window);
    if (e.length()) {
        bool sent = Serial.availableForWrite() >= int(e.length() + 2) && Serial.println(e) == e.length() + 2;
        usb.windows.finish(window, sent);
        if (window.id) recordWindowAttempt(window, sent, millis());
    }
    xSemaphoreGive(guard);
    // AsyncWebServer can call connect/disconnect while holding its client-list
    // lock. Never look up a server client while holding the session mutex.
    xSemaphoreTake(guard, portMAX_DELAY);
    uint32_t clientId = phone.id;
    uint32_t sessionId = phone.session.sid;
    e = clientId ? eventFrame(phone.session, now, window) : String();
    xSemaphoreGive(guard);
    if (clientId && e.length()) {
        bool sent = ws.availableForWrite(clientId) && ws.text(clientId, e);
        if (window.id) {
            recordWindowAttempt(window, sent, millis());
            xSemaphoreTake(guard, portMAX_DELAY);
            if (phone.id == clientId && phone.session.sid == sessionId) phone.session.windows.finish(window, sent);
            xSemaphoreGive(guard);
        }
    }
    if (elapsed(now, cleanupAt, 1000)) {
        ws.cleanupClients(UINT16_MAX);
        cleanupAt = now;
    }
    delay(2);
}

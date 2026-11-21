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

extern const uint8_t panel[] asm("_binary_web_index_html_start");
namespace {
AsyncWebServer server(80);
AsyncWebSocket ws("/ws");
SemaphoreHandle_t guard;
struct Client {
    uint32_t id = 0;
    String frame;
    Session session;
};
Client clients[4];
Session usb;
String line;
bool discard = false;
uint32_t cleanupAt;
char ssid[24], password[64];

void websocket(AsyncWebSocket *, AsyncWebSocketClient *socket, AwsEventType type, void *arg, uint8_t *data,
               size_t size) {
    if (type != WS_EVT_CONNECT && type != WS_EVT_DISCONNECT && type != WS_EVT_DATA)
        return;
    xSemaphoreTake(guard, portMAX_DELAY);
    Client *slot = nullptr;
    for (auto &c : clients)
        if (c.id == socket->id()) {
            slot = &c;
            break;
        }
    if (type == WS_EVT_CONNECT) {
        for (auto &c : clients)
            if (!c.id) {
                c.id = socket->id();
                slot = &c;
                break;
            }
        if (!slot)
            socket->close(1013, "busy");
    } else if (slot && type == WS_EVT_DISCONNECT) {
        stopSession(slot->session.sid);
        *slot = Client{};
    } else if (slot && type == WS_EVT_DATA) {
        auto *f = static_cast<AwsFrameInfo *>(arg);
        if (f->index == 0 && f->num == 0)
            slot->frame = "";
        if (f->message_opcode != WS_TEXT || f->len > 1024 || slot->frame.length() + size > 1024) {
            stopSession(slot->session.sid);
            socket->close(1009, "frame");
        } else {
            slot->frame.concat(reinterpret_cast<char *>(data), size);
            if (f->final && f->index + size == f->len) {
                String reply = handleFrame(slot->session, slot->frame, false, socket->client()->localIP() == WiFi.softAPIP());
                if (!socket->text(reply)) {
                    stopSession(slot->session.sid);
                    socket->close();
                }
                slot->frame = "";
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
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *r) {
        r->send(200, "text/html; charset=utf-8", (const char *)panel);
    });
    ws.setFilter([](AsyncWebServerRequest *r) {
        return !r->hasHeader("Origin") || consoleOrigin(r->header("Origin"), r->client()->localIP());
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
                String reply = handleFrame(usb, line, true);
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
    String e = eventFrame(usb, now);
    if (e.length() && Serial.availableForWrite() >= int(e.length() + 2))
        Serial.println(e);
    xSemaphoreGive(guard);
    // AsyncWebServer can call connect/disconnect while holding its client-list
    // lock. Never look up a server client while holding the session mutex.
    for (auto &c : clients) {
        xSemaphoreTake(guard, portMAX_DELAY);
        uint32_t clientId = c.id;
        e = clientId ? eventFrame(c.session, now) : String();
        xSemaphoreGive(guard);
        if (clientId && e.length() && ws.availableForWrite(clientId))
            ws.text(clientId, e);
    }
    if (elapsed(now, cleanupAt, 1000)) {
        ws.cleanupClients(4);
        cleanupAt = now;
    }
    delay(2);
}

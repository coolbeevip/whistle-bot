// SPDX-License-Identifier: Apache-2.0
#pragma once
using esp_timer_handle_t = void *;
struct esp_timer_create_args_t { void (*callback)(void *); const char *name; };
void esp_timer_create(esp_timer_create_args_t *, esp_timer_handle_t *);
void esp_timer_start_periodic(esp_timer_handle_t, int64_t);
void esp_timer_start_once(esp_timer_handle_t, int64_t);
void esp_timer_stop(esp_timer_handle_t);
bool esp_timer_is_active(esp_timer_handle_t);
int64_t esp_timer_get_time();
#define ESP_ERROR_CHECK(value) (value)

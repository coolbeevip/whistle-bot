#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu
cd "$(dirname "$0")/../.."
json=${ARDUINOJSON_SRC:-.pio/libdeps/esp32-s3-devkitc-1/ArduinoJson/src}
if [ ! -f "$json/ArduinoJson.h" ]; then
    echo "Install project dependencies with pio pkg install -d esp32-s3 or set ARDUINOJSON_SRC." >&2
    exit 2
fi
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
case $(uname -s) in
    Darwin) link=-Wl,-dead_strip ;;
    Linux) link=-Wl,--gc-sections ;;
    *) echo "Use macOS or Linux for the host firmware runner." >&2; exit 2 ;;
esac
host=test/protocol/host
"${CXX:-c++}" -std=c++17 -ffunction-sections -fdata-sections "$link" \
    -include "$host/Arduino.h" -I"$host" -Itest/host -I"$json" \
    test/protocol/firmware.cpp src/protocol/session.cpp src/drivers/yahboom.cpp -o "$build/firmware"
node test/protocol/baseline.cjs "$build/firmware" "$@"

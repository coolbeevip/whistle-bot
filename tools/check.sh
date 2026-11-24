#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu
cd "$(dirname "$0")/.."
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
controller=esp32-s3
"${CXX:-c++}" -std=c++17 "$controller/test/motion_test.cpp" -o "$build/motion"
"$build/motion"
"${CXX:-c++}" -std=c++17 -I "$controller/test/host" \
    "$controller/test/yahboom_test.cpp" "$controller/src/drivers/yahboom.cpp" -o "$build/yahboom"
"$build/yahboom"
"${CXX:-c++}" -std=c++17 "$controller/test/window_delivery_test.cpp" -o "$build/window-delivery"
"$build/window-delivery"
"${CXX:-c++}" -std=c++17 "$controller/test/heading_test.cpp" -o "$build/heading"
"$build/heading"
node --check raspberry-pi/static/console.js
python3 -m compileall -q raspberry-pi tools
PYTHONPATH=raspberry-pi python3 -m unittest discover -s raspberry-pi/tests

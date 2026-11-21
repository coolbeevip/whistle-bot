#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
set -eu
cd "$(dirname "$0")/.."
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
controller=firmware/controller
"${CXX:-c++}" -std=c++17 "$controller/test/motion_test.cpp" -o "$build/motion"
"$build/motion"
"${CXX:-c++}" -std=c++17 -I "$controller/test/host" \
    "$controller/test/yahboom_test.cpp" "$controller/src/drivers/yahboom.cpp" -o "$build/yahboom"
"$build/yahboom"
node --check upper/camera-preview/static/console.js
python3 -m compileall -q upper/camera-preview tools
PYTHONPATH=upper/camera-preview python3 -m unittest discover -s upper/camera-preview/tests

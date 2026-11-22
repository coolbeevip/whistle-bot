# SPDX-License-Identifier: Apache-2.0
"""Embed the browser representation at build time so serving it needs no compression RAM."""
import gzip
import hashlib
from pathlib import Path

Import("env")  # provided by PlatformIO

page = (Path(env.subst("$PROJECT_DIR")) / "web/index.html").read_bytes()
compressed = gzip.compress(page, compresslevel=9, mtime=0)
tag = hashlib.sha256(page).hexdigest()[:24]
header = Path(env.subst("$BUILD_DIR")) / "generated/panel_gzip.h"
header.parent.mkdir(parents=True, exist_ok=True)
content = (
    f'static constexpr char panelTag[] = R"(W/"{tag}")";\n'
    + "static const uint8_t gzipPanel[] = {\n"
    + "\n".join("    " + ",".join(map(str, compressed[i:i+24])) + "," for i in range(0, len(compressed), 24))
    + "\n};\n"
)
if not header.exists() or header.read_text() != content:
    header.write_text(content)
env.Append(CPPPATH=[str(header.parent)])

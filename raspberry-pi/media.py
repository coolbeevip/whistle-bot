# SPDX-License-Identifier: Apache-2.0
"""Publish a seekable MP4 using the parameter sets from the actual camera stream."""
import os
import subprocess
import tempfile
from pathlib import Path


def finalize_mp4(source):
    fd, temporary = tempfile.mkstemp(prefix=".final-", suffix=".mp4", dir=source.parent)
    os.close(fd)
    try:
        subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-xerror", "-y", "-i", str(source),
            "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "h264_mp4toannexb,extract_extradata",
            "-movflags", "+faststart", temporary,
        ], check=True)
        os.chmod(temporary, source.stat().st_mode & 0o777)
        os.replace(temporary, source)
    finally:
        Path(temporary).unlink(missing_ok=True)

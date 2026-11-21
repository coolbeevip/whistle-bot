# SPDX-License-Identifier: Apache-2.0
"""Independent ISP streams for the browser preview and timestamped H.264 recording."""
import io
import threading
import time

import av  # Load the MP4 muxer before the first Record press.
import numpy as np
import simplejpeg
from PIL import Image
from picamera2 import MappedArray, Picamera2
from picamera2.encoders import H264Encoder
from picamera2.encoders.libav_h264_encoder import LibavH264Encoder
from picamera2.outputs import PyavOutput

from resolutions import SIZES


class Camera:
    def __init__(self):
        self.lock = threading.Lock()
        self.device = self.encoder = self.config = None
        self.last_view = 0
        self.error = None

    def close_camera(self):
        if self.device:
            self.device.close()
            self.device = self.config = None

    def configure(self, main, lores, fps):
        if (main, lores, fps) == self.config:
            return
        self.close_camera()
        cam = Picamera2(tuning=Picamera2.load_tuning_file("ov5647_noir.json"))
        try:
            cam.configure(cam.create_video_configuration(
                main={"size": SIZES[main], "format": "YUV420"},
                lores={"size": SIZES[lores], "format": "YUV420"},
                controls={"FrameRate": fps}, queue=False, buffer_count=4))
            cam.start()
            self.device, self.config = cam, (main, lores, fps)
        except Exception:
            cam.close()
            raise

    def frame(self, after, width):
        with self.lock:
            self.last_view = time.monotonic()
            if not self.device or (not self.encoder and width > self.config[0]):
                self.configure(max(1280, width), 640, 15)
            main, lores, _ = self.config
            name = "lores" if width <= lores else "main"
            src_w, src_h = SIZES[lores if name == "lores" else main]
            dst_w, dst_h = SIZES[width]
            with self.device.captured_request() as request:
                number = request.get_metadata()["SensorTimestamp"]
                with MappedArray(request, name) as mapped:
                    # Crop 4:3 to 16:9 before reducing the full sensor image.
                    h = min(src_h, src_w * dst_h // dst_w) // 2 * 2
                    top = (src_h - h) // 4 * 2
                    step = max(1, min(src_w // dst_w, h // dst_h))
                    # Keep the subsampled luma/chroma planes in a valid 4:2:0 ratio.
                    w = src_w // (2 * step) * 2 * step
                    h = h // (2 * step) * 2 * step
                    y = mapped.array[top:top+h:step, :w:step]
                    uv = mapped.array.reshape((-1, mapped.array.strides[0] // 2))
                    u0 = 2 * src_h + top // 2
                    v0 = u0 + src_h // 2
                    u = uv[u0:u0+h//2:step, :w//2:step]
                    v = uv[v0:v0+h//2:step, :w//2:step]
                    if step > 1:
                        y, u, v = (np.ascontiguousarray(plane) for plane in (y, u, v))
                    jpeg = simplejpeg.encode_jpeg_yuv_planes(y, u, v, 82)
        if (w // step, h // step) != (dst_w, dst_h):
            with Image.open(io.BytesIO(jpeg)) as picture:
                output = io.BytesIO()
                picture.resize((dst_w, dst_h), Image.Resampling.BILINEAR).save(output, "JPEG", quality=82)
                jpeg = output.getvalue()
        return jpeg, number

    def start_video(self, path, width):
        with self.lock:
            # Reserve native resolution on main so any preview size remains available
            # during recording without restarting the encoder or interrupting the MP4.
            full = width == 2592
            self.configure(2592, 1280 if full else width, 5 if full else 15)
            self.error = None
            if full:
                encoder = LibavH264Encoder(bitrate=8_000_000, repeat=True, iperiod=5, framerate=5)
                encoder.threads = 2
            else:
                bitrate = {640: 1_200_000, 1280: 3_000_000, 1920: 5_000_000}[width]
                encoder = H264Encoder(bitrate=bitrate, repeat=True, iperiod=15)
            output = PyavOutput(str(path), format="mp4",
                                options={"movflags": "frag_keyframe+empty_moov+default_base_moof"})
            output.error_callback = lambda error: setattr(self, "error", str(error))
            self.device.start_encoder(encoder, output, name="main" if full else "lores")
            self.encoder = encoder

    def stop_video(self):
        with self.lock:
            encoder = self.encoder
            try:
                self.device.stop_encoder(encoder)
                return encoder.firsttimestamp
            finally:
                self.encoder = None
                self.close_camera()

    def idle(self, force=False):
        with self.lock:
            if not self.encoder and (force or time.monotonic() - self.last_view > 5):
                self.close_camera()

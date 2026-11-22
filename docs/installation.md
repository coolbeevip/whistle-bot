# 安装树莓派控制台

参考平台为 Raspberry Pi 3 Model B、CSI OV5647 和带 Picamera2 的 64 位 Raspberry Pi OS 环境。上位机使用 Python 3.11 或更高版本。网页资源随源码提供，运行服务时无需 Node.js。

## 准备环境

在树莓派上检查摄像头，然后安装系统媒体依赖。

```sh
sudo apt update
sudo apt install rpicam-apps python3-venv python3-picamera2 python3-av python3-simplejpeg python3-numpy python3-pil python3-serial ffmpeg
rpicam-hello --list-cameras
```

## 启动服务

从仓库根目录执行以下命令。用户服务使用固定的工作目录，复制时应保留整个目录，包括 `static/` 下的浏览器资源。

```sh
mkdir -p ~/whistle-rover/camera-preview ~/.config/systemd/user
cp -R raspberry-pi/. ~/whistle-rover/camera-preview/
python3 -m venv --system-site-packages ~/whistle-rover/venv
~/whistle-rover/venv/bin/pip install -r ~/whistle-rover/camera-preview/requirements.txt
cp raspberry-pi/rover-camera.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now rover-camera
systemctl --user status rover-camera
```

在同一受信局域网的浏览器打开 `http://<树莓派主机名>:8080/`。当前服务监听本机所有接口，网页可直接控制底盘、录像和 AI 配置。树莓派需有权访问相机、串口与录像目录。连接 CP2102N 数据口后检查顶部的 Drive 状态；单独验证相机时可保持底盘离线。

## 持久化数据

| 位置 | 内容 |
| --- | --- |
| `~/Videos/whistle-rover/` | 每段录像的 MP4、JSON 和录制中的临时目录。可用 `ROVER_RECORDINGS` 改变路径 |
| `~/.config/whistle-rover/` | 底盘偏好与可选 AI 服务凭据 |
| 浏览器本地存储 | 当前设备的预览、录像分辨率选择 |

升级时先结束驾驶任务并完成录像，再更新服务文件并执行 `systemctl --user restart rover-camera`。排查启动问题可运行 `journalctl --user -u rover-camera -n 50`。

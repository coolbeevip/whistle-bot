# 树莓派控制台使用指南

手机连接树莓派所在局域网，浏览器打开 `http://<树莓派主机名>:8080/`。手机底部有 **Drive**、**Recordings** 和 **Settings** 三栏。Drive 页的摄像头画面四角显示直播状态、录制状态与计时、分辨率及录制按钮。拖动虚拟摇杆可切换四个方向，回到中心或松手即释放；也支持键盘箭头键。Settings 中的 Preview resolution 控制驾驶预览，Recording resolution 控制下一段录像，两项设置分别保存在当前浏览器，预览默认为 640 × 360，录像默认为 1280 × 720。两项均可选 640 × 360、1280 × 720、1920 × 1080 和 2592 × 1944；预览另有 320 × 180。选择高于 720p 的档位时会提示带宽、存储或帧率影响，取消即可保留原选择。树莓派通过 USB-A 连接 ESP32 的 UART 口后自动识别 CP2102N；松开按键即释放控制权。显示 **Drive offline** 时仍可录像，录制期间的离线按键会标为 `offline`。

Drive 页可选 G1–G4，默认前进和倒车目标速度依次为 0.20、0.40、0.60、0.80 m/s。Settings 的 **Chassis** 区可分别调整四档速度与原地转速。Drive 的 Mode 按钮切换 Comfort（平顺提速）和 Sport（快速提速）。树莓派保存这些设置并同步给所有浏览器，下一次方向输入才会采用新值。连接 ESP32 后速度上限按固件报告的能力计算；距离未标定时以轮径和编码器计数估算。录像 JSON 的 `record_start` 保存设置快照，`chassis_setting` 记录改动及时间，`down` 同时保存该次请求的设置和下发参数。

## Auto 视觉驾驶

在 Settings → AI 填写完整 HTTP(S) Endpoint，可选 Model 和 Bearer API key。Test connection 会把当前 640 × 360 JPEG 和测试指令发给该地址，解析一次回复。点 Save 将配置保存到树莓派。模型服务需自行提供。

在 Drive → Auto 输入任务并点 GO。每轮只执行一个动作，ESP32 确认动作完成且底盘静止后重新拍摄，继续发送原始任务。Stop 或切换到 Joystick / Precision 会取消任务；底盘确认静止后才能接管。发起任务的浏览器断开也会停止任务。单次最多 20 轮、总时长 120 秒。动作使用现有距离和转角标定。

普通端点接收 JSON POST，字段为 `instruction`、`step`、`rules`、`image`（JPEG data URL）以及可选 `model`。以 `/chat/completions` 结尾的地址使用多模态聊天格式，从 `choices[0].message.content` 读取 JSON。服务每次返回下列任意一种对象，前进范围 0.001–0.30 m，原地转向范围 1–45°。

```json
{"action":"forward","meters":0.15}
```

转向使用 `{"action":"left","degrees":30}` 或 `{"action":"right","degrees":30}`。完成或无法判断下一步时返回 `{"action":"stop"}`。超时、超范围或无法解析的回复会终止任务。


## 录像与事件时间线

点 **Record** 开始，点 **Stop recording** 完成。在 **Recordings** 点 **Play** 可直接播放，点 **MP4** 或 **JSON** 可分别下载。勾选多条录像或点 **Select all**，再点 **Delete** 并确认，会同时删除选中录像及其按键记录。文件在树莓派的 `~/Videos/whistle-rover/<录像编号>/`，视频采用 H.264；1080p 及以下录像目标 15 fps，2592 × 1944 使用软件编码，目标 5 fps。浏览器断开时会释放手动驾驶，正在进行的录像可在重连后停止。

JSON 的 `record_start`、`record_stop`、`down`、`up` 记录树莓派的 UTC、启动时钟微秒和浏览器输入时间 `browser_epoch_ms`。系统补记的断开事件没有浏览器时间。`video_ms` 以传感器首帧为零点，根据树莓派接收事件的时刻计算；开始按钮可能早于首帧。`down.dispatch` 表示是否请求驱动，`drive_result` 中的 `drive_ack` 表示 ESP32 接受速度指令。树莓派服务使用系统 Picamera2、pySerial 和虚拟环境中的 aiohttp，浏览器入口是 index.html，样式和交互脚本位于 static/。server.py 负责 HTTP/WebSocket 路由，chassis.py 管理底盘串口，camera.py 管理相机，recording.py 维护视频和事件的发布过程，preferences.py 负责档位配置迁移与持久化。源代码在 [树莓派服务](../upper/camera-preview/)。

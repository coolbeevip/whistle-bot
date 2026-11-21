# 树莓派控制台使用指南

手机连接树莓派所在局域网，打开 `http://<树莓派主机名>:8080/`。顶部的 **Drive online** 表示底盘可用。底盘离线时仍可预览摄像头和录像。

## 驾驶

| Drive 模式 | 操作 |
| --- | --- |
| Joystick | 拖动摇杆控制方向，松手停车。G1–G4 选择目标速度，Comfort / Sport 切换加速方式 |
| Precision | 选择前进、后退、左转或右转，设置距离或角度后点 **GO**。运行期间点 **Stop** 可中止 |
| Auto | 输入任务后点 **GO**。树莓派向视觉模型请求下一步动作，等待底盘完成该步后再取帧 |

在 **Settings → Chassis** 调整各档速度和原地转速，下一次方向输入时生效。**Settings → Resolution** 分别设置预览与录像分辨率，默认值为 640 × 360 和 1280 × 720。

## Auto 视觉驾驶

在 Settings → AI 填写完整 HTTP(S) Endpoint，可选 Model 和 Bearer API key。Test connection 会把当前 640 × 360 JPEG 和测试指令发给该地址，解析一次回复。点 Save 将配置保存到树莓派。模型服务需自行提供。

在 Drive → Auto 输入任务并点 GO。每轮只执行一个动作，ESP32 确认动作完成且底盘静止后重新拍摄，继续发送原始任务。Stop 或切换到 Joystick / Precision 会取消任务；底盘确认静止后才能接管。发起任务的浏览器断开也会停止任务。单次最多 20 轮、总时长 120 秒。动作使用现有距离和转角标定。

普通端点接收 JSON POST，字段为 `instruction`、`step`、`rules`、`image`（JPEG data URL）以及可选 `model`。以 `/chat/completions` 结尾的地址使用多模态聊天格式，从 `choices[0].message.content` 读取 JSON。服务每次返回下列任意一种对象，前进范围 0.001–0.30 m，原地转向范围 1–45°。

```json
{"action":"forward","meters":0.15}
```

转向使用 `{"action":"left","degrees":30}` 或 `{"action":"right","degrees":30}`。完成或无法判断下一步时返回 `{"action":"stop"}`。超时、超范围或无法解析的回复会终止任务。

## 录像与事件时间线

点 **Record** 开始录像，点 **Stop recording** 生成配对的 MP4 和 JSON。在 **Recordings** 可播放、分别下载或批量删除；删除一条记录会同时移除两个文件。

JSON 记录录像起止、方向键按下与松开、驾驶设置变化和底盘应答。`video_ms` 相对视频首帧计时，开始事件可能为负值。`down.dispatch` 表示输入的转发状态，`drive_ack` 表示 ESP32 接受了指令。存储目录见[安装指南](installation.md#持久化数据)。

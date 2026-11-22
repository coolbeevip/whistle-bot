# 控制器构建与调试

正式固件位于 [firmware/controller](../firmware/controller)。在该目录使用 PlatformIO Core。先通过设备列表识别 ESP32 的 UART 下载口，再用实际端口替换示例中的占位符。

```sh
pio run
pio device list
pio run -t upload --upload-port <ESP32串口>
pio device monitor -p <ESP32串口> -b 115200
```

烧录会替换 ESP32 当前程序。下载端口是 ESP32 自身标有 UART 的 USB 口。打开串口监视器后按一次 RESET，启动消息 `wifi_setup` 给出本机热点名称和密码。手机连上该热点后打开 `http://192.168.4.1/`，进入板载控制面板。网页随固件一起烧录，可以离线使用。

## 网络设置

在板载 **Settings → Wi-Fi settings** 选择 2.4 GHz 网络，输入密码并点 **Test & save**。连接成功后，在同一局域网使用面板显示的地址访问。长按 **BOOT** 5 秒可停车并恢复热点，保留网络凭据和标定。蓝灯表示热点就绪，绿灯表示已连接家庭网络。

## 驾驶和标定

1. 按[参考接线](hardware.md)连接两板，架空车轮并给驱动板供电。确认面板显示底盘在线，左右轮的通道与方向正确。
2. 在 **Calibration** 保存方向映射。距离标定可将车轮向前转一整圈，输入轮周长；参考轮径 67.5 mm 对应约 212 mm。保存后完成距离复测，即可执行定距动作。
3. 在转角标定页输入相对地面参考线量得的实际转角，保存并完成复测，即可执行定角动作。重新标定距离后应复测距离与转角。
4. 手动驾驶按住方向键运动，松开即释放控制权。单次定距上限为 3 m，定角上限为 360°。

## 上位机协议

USB 使用每行一个 JSON 对象（115200、8N1），Wi-Fi 使用 `ws://192.168.4.1/ws`（每条文本消息一个对象）。首先发送：

```json
{"v":1,"id":1,"op":"hello"}
```

后续消息填入应答中的数字 `session`，递增 `id`。发送 `status` 查询状态，或发送 `subscribe`、`topic:"encoders"`、`hz:5` 订阅反馈。`claim` 返回数字 `lease` 和 `window`；在持有期间按 `control_window` 事件更新窗口。手动驾驶以 10 Hz 发送 `drive`。定距与定角只提交一次目标并附 `request_key`，随后发 `heartbeat` 续期。两个入口共用驾驶权，手机和 USB 客户端可同时观察。可选雷达适配器接口位于 [lidar.h](../firmware/controller/src/sensors/lidar.h)，默认配置无雷达。

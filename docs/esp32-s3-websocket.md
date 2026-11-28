# ESP32-S3 WebSocket 通信协议 v1

本文面向直接连接 Whistle Bot 底盘的客户端。只读客户端完成 `hello` 后即可查询和订阅。需要驱动车轮时，再向同一连接申请独占控制权。Wi-Fi 与 USB 客户端共享控制权、底盘状态和动作历史。

## 连接与消息

| 项目 | 约定 |
| --- | --- |
| 地址 | 热点模式为 `ws://192.168.4.1/ws`，局域网模式为 `ws://<小车局域网 IP>/ws`，端口均为 80。 |
| 消息 | 一条 WebSocket 文本消息承载一个 UTF-8 JSON 对象。客户端发往设备的消息最多 1024 字节，分片按合计长度计算。二进制消息或超限触发关闭码 `1009`。 |
| 连接数 | 最多 4 个 WebSocket 客户端，连接已满时关闭新连接，码为 `1013`。 |
| Origin | 带 `Origin` 的握手仅接受 `http://localhost:8765`、`http://127.0.0.1:8765`、`http://whistle-console.localhost`。未带该头的原生客户端可直接握手。 |
| 时间与标识 | 设备时间为启动以来的毫秒数。毫秒时钟和协议标识使用无符号 32 位数。用 `boot_id` 区分设备重启，按回绕处理时间差。 |

**请求**包含 `v: 1`、非零递增整数 `id` 和字符串 `op`。除 `hello` 外均须带当前连接的 `session`。**应答**包含 `v`、`ok` 和对应的 `id`，失败时另有字符串 `error`。消息损坏或版本、编号无效时，应答可能没有 `id`。**事件**带 `v`、`event` 和 `t_ms`，可与应答交错。客户端按 `id` 匹配应答，按 `event` 分发推送。

### 首次连接示例

以下三个 JSON 对象分别发送。首条是完整的握手请求。

```json
{"v":1,"id":1,"op":"hello"}
```

成功应答给出 `session`、`boot_id`、`capabilities`、`basic_ticks_min`、`basic_ticks_max`、`basic_ticks_default`、`max_abs_mm_s` 和 `max_twist_mm_s`。假设返回的 `session` 为 41，先查询快照，再订阅 5 Hz 遥测。

```json
{"v":1,"id":2,"session":41,"op":"status"}
```

```json
{"v":1,"id":3,"session":41,"op":"subscribe","topic":"encoders","hz":5}
```

`subscribe` 成功应答为 `{"v":1,"id":3,"ok":true}`，随后另行推送事件。每个主题独立设置，`hz` 为 0 至 10 的整数，0 表示取消。新会话的订阅频率为 0。

### 序号、重试与重连

- 同一连接只缓存最近一次被记录的请求和应答。立即重发相同 `id` 且原文逐字节相同的请求可取得缓存应答。改动空白、字段顺序或重发更早的普通请求会触发 `STALE_ID`。部分提前返回的校验错误不会更新缓存。客户端应持续分配新序号。
- `wifi_test` 不缓存请求原文。同一编号重发时返回 `STALE_ID`，用新的 `id` 查询 `wifi_status` 确认结果。
- 新的 `hello` 会重置本连接会话，并停止旧会话持有的控制。断线后重新握手、订阅、读取状态；丢弃旧 `lease` 和 `window`。对结果未知的动作先查询历史。

## 局域网发现

设备通过 mDNS 广播 `_whistlebot._tcp.local.`，实例名与热点名相同。手机连接服务地址上的 `/ws`，核对 `hello.device_id` 与所选车辆一致后再订阅。该标识跨重启和 DHCP 换址保持稳定，`boot_id` 标识一次启动。选车首页需要能返回稳定标识的固件。

## 控制权与续期

底盘空闲、驱动反馈有效且车轮停稳时可申请控制。普通驾驶还要求方向映射有效。成功的 `claim` 或 `cal_begin` 应答包含 `lease`、`window`、`accepted_ms` 和 `expires_at_ms`。窗口编号由设备生成，客户端应原样回传。

| 申请方式 | 可执行的操作 | 续期上限 |
| --- | --- | --- |
| `claim` | 通用驾驶，包括 `drive_twist`、精确动作。手动驾驶通过新的驾驶指令续期，动作运行期间通过 `heartbeat` 续期。 | 窗口生成后 300 ms |
| `claim` 加 `manual_pad: true` | `drive`、`drive_low`，持续按住时反复发送当前目标，松手发送 `release`。 | 450 ms |
| `claim` 加 `precision: true` | `move_distance`、`turn_angle`，动作运行期间发送 `heartbeat`。 | 450 ms |
| `cal_begin` | 创建标定草稿，使用标定指令和 `heartbeat`。 | 300 ms |

两个 `claim` 标志互斥。设备约每 100 ms 生成新窗口，并向持有者推送 `control_window`。普通和标定模式接受最近两个窗口；450 ms 模式检查最近五个窗口，并拒绝早于已接受期限的窗口。设备以**窗口生成时间**计算截止时间。仅接收事件、重复引用同一窗口或收到失败应答均不能向后延长期限。

| 操作 | 需要的字段 | 行为 |
| --- | --- | --- |
| `heartbeat` | `lease`、`window` | 为标定会话或正在运行的精确动作续期。 |
| `release` | `lease` | 持有者停车并交还控制权，无须有效窗口。可选 `reason` 支持 `page_hidden`、`focus_lost`、`heartbeat_failed`、`command_failed`，其他值按 `released` 处理。 |
| `stop` | 仅公共请求字段 | 任一已握手会话均可请求全局停车，释放当前持有者。收到应答后，观察 `settled` 确认车轮停稳。 |

### 精确动作示例

下表接续首次连接示例。标识值仅供示意，客户端应使用设备在该次连接中返回的值。示例假设 `precision_ready: true`，设备已声明 `move_speed`。

| 方向 | 消息或处理 |
| --- | --- |
| 客户端 → 设备 | `{"v":1,"id":4,"session":41,"op":"claim","precision":true}` |
| 设备 → 客户端 | `{"v":1,"id":4,"ok":true,"lease":52,"window":73,"accepted_ms":8000,"expires_at_ms":8450}` |
| 客户端 → 设备 | `{"v":1,"id":5,"session":41,"op":"move_distance","lease":52,"window":73,"distance_mm":250,"speed_mm_s":100,"request_key":"trip-001"}` |
| 设备 → 客户端 | `{"v":1,"id":5,"ok":true,"action_id":9}` |
| 设备 → 客户端 | `{"v":1,"event":"control_window","t_ms":8100,"lease":52,"window":96,"expires_at_ms":8550}` |
| 客户端 → 设备 | `{"v":1,"id":6,"session":41,"op":"heartbeat","lease":52,"window":96}` |
| 直到结束 | 持续使用最新窗口续期。通过 `action` 事件或 `status` 跟踪 `action_id: 9`、`action_state` 和 `action_reason`。 |

## 驾驶指令

下列操作均需持有匹配的 `lease`，新指令需携带有效 `window`。轮速和距离以前进为正，转角以左转为正。运行上限以设备握手、状态和就绪标志为准。

| `op` | 业务字段 | 约束与含义 |
| --- | --- | --- |
| `drive_low` | `left_dir`、`right_dir`；可选 `ticks_s`、`acceleration` | 两侧方向各取整数 −1、0、1。显式给定的共同转速为 150–9000 ticks/s。省略会进入旧版基础驱动逻辑；新客户端可显式使用握手公布的推荐值 `basic_ticks_default`（325）。 |
| `drive` | `left_mm_s`、`right_mm_s`；可选 `acceleration` | 两侧分别使用有符号整数 mm/s，需要 `distance_ready`。绝对值不得超过 `manual_max_mm_s`，固件硬上限为 1060。 |
| `drive_twist` | `linear_mm_s`、`angular_mrad_s` | 通用租约，要求 `calibrated`。线速度整数 −100 至 100，角速度整数 −4000 至 4000。用有效轮距换算左右轮速，超速时等比例缩放。 |
| `move_distance` | `distance_mm`、`request_key`；可选 `speed_mm_s` | 有限数值，绝对距离 1–3000 mm。检测 `move_speed` 能力后可指定正整数巡航上限，受 `manual_max_mm_s` 限制；省略时采用 60 mm/s 上限。 |
| `turn_angle` | `angle_deg`、`request_key` | 有限数值，绝对角度 1–360°。陀螺仪测量实际转角。 |

`acceleration` 取 `smooth`（默认）或 `responsive`。两个精确动作均要求车轮停稳且 `precision_ready` 为真，即距离标定已验证、航向可用。普通精确动作完成后会释放控制权。

**动作去重。** 每个新动作及标定试跑使用独立的 `request_key`（1–40 字节字符串）。设备在内存中保留最近 16 个动作。在控制权等前置检查通过时，同一会话重用同一键、方向类型、目标和速度，返回原 `action_id`；不匹配返回 `CONFLICT`。应答丢失或重连后，可发送 `status` 并附 `request_key` 或 `action_id` 查询；两者同时提供时键优先。命中时动作字段来自历史，底盘和传感器字段仍是当前快照。超出保留范围或重启后可返回 `UNKNOWN_RESULT`。

## 标定事务

`cal_begin` 从已保存参数复制草稿。在该会话内，`status.calibration` 为草稿，`saved_calibration` 为已保存版本。其他连接读取已保存参数。持续用最新窗口发送 `heartbeat`，包括等待人工测量时。

发送 `cal_sample` 时用 `step` 指定步骤，携带 `lease`、`window`。下表仅列额外字段。

| `step` | 字段与效果 |
| --- | --- |
| `jog` | `channel` 取 3 或 4，`direction` 取 −1 或 1。可选 `spin: true` 在已有映射时使两轮反向转动。单次点动最长 250 ms。 |
| `jog_stop` | 立即结束点动。持有标定租约即可，无须有效窗口。 |
| `map` | `left_channel` 取 3 或 4；`left_motor_sign`、`right_motor_sign`、`left_encoder_sign`、`right_encoder_sign` 各取 −1 或 1。更改映射会清空草稿中的距离和轮距标定。 |
| `start` | 必填布尔值 `turn`。车轮停稳后记录采样起点。距离采样要求已有方向映射，转角采样还要求有效距离尺度。 |
| `finish` | `turn` 与起点一致，提供外部实测的 `distance_mm` 或 `angle_deg`。车轮须已停稳，数值范围同驾驶指令。距离样本更新左右轮尺度并清除两项验证位；转角样本更新有效轮距并清除转角验证位。 |
| `trial` | `turn`、对应的 `distance_mm` 或 `angle_deg`、独立的 `request_key`。按草稿参数驱动车轮，返回 `action_id`。成功试跑设置相应验证位，保留控制权以便保存。 |

以 `cal_checkpoint` 保存可存储的阶段性结果；`cal_commit` 额外要求两项验证均已通过。两者均需 `lease`、`window` 和静止底盘，受理后释放控制权并异步写入。观察 `reason` 变为 `saved` 或 `save_failed`，结合 `cal_revision` 确认保存结果。`cal_cancel` 携带当前 `lease` 可放弃草稿并停车，无须有效窗口。

## 事件与状态字段

| `event` | 触发与载荷 |
| --- | --- |
| `control_window` | 仅向控制权持有者发送。字段为 `lease`、`window`、`expires_at_ms`。 |
| `status`、`action` | 无须订阅。所有者、原因、驱动在线状态或动作状态变化时发送快照。有动作且动作编号或状态变化时使用 `action`。 |
| `encoders` | 按订阅频率发送快照，额外包含驱动反馈有效标志 `valid`。 |
| `lidar_sectors` | 仅安装雷达且已订阅时发送。含扫描时间 `t_ms`、序号 `seq`、四个 `sectors`。每项含 `from_deg`、`to_deg`、`valid` 和 `min_mm`（无效时为 null）。扇区边界依次为 315→45、45→135、135→225、225→315 度。 |

发生竞争时，发送顺序优先考虑控制窗口，再依次考虑变化通知、雷达和编码器遥测。订阅频率是发送目标。客户端可用 `status` 主动刷新，并应允许条件字段缺失。

| 快照字段 | 含义 |
| --- | --- |
| `boot_id`、`owner`、`reason` | 本次启动标识、控制权相对于本连接的归属（`free`、`self`、`wifi`、`usb`）、最近底盘状态原因。 |
| `driver_online`、`feedback_age_ms`、`settled` | 驱动板反馈是否新鲜、距最近反馈的毫秒数、车轮已静止且停车过程已结束。 |
| `manual_ready`、`distance_ready`、`yaw_ready`、`precision_ready`、`calibrated` | 依次表示方向有效、距离已验证、航向就绪、精确动作就绪、几何参数完整且距离和转角均已验证。 |
| `manual_max_mm_s`、`target_left_mm_s`、`target_right_mm_s` | 手动轮速上限和左右轮物理速度目标。 |
| `m3_ticks`、`m4_ticks`；`left_ticks`、`right_ticks` | 物理通道累计计数；后两项仅在已有方向映射时提供，已换算为逻辑左右轮及前进正方向。 |
| `rate_at_ms`、`rate_window_ms`、`left_target_ticks_s`、`right_target_ticks_s`、`left_ticks_s`、`right_ticks_s`、`left_pwm`、`right_pwm` | 测速时间及窗口、左右参考与实测计数速率、逻辑左右轮对应的有符号驱动输出。 |
| `action_id`、`action_state`、`action_reason` | 动作编号（0 表示尚无动作）、状态（`idle`、`running`、`completed`、`failed`、`cancelled`）及动作自身的原因。 |
| `action_target_mm` 或 `action_target_deg`、`action_yaw_deg` | 动作目标；陀螺仪动作另有相对起点的实测航向。左右轮目标和进度为 `left_goal_mm`、`right_goal_mm`、`left_progress_mm`、`right_progress_mm`。 |
| `brake_yaw_deg`、`brake_rate_dps`、`coast_deg`、`brake_to_confirmed_rest_ms` | 指定动作查询时可用的制动诊断。开始制动后有前两项，确认静止后可有后两项。 |
| `calibrating`、`cal_revision`、`calibration`、`saved_calibration` | 标定会话状态、已保存修订号及参数对象。对象含 `revision`、`mapped`、映射步骤中的五个字段、`left_mm_tick`、`right_mm_tick`（mm/tick）、`track_mm`、`checks`（位 0 距离，位 1 转角）。 |
| `imu`、`wheel_odom` | 可选对象。`imu` 提供采样时间 `t_ms`、XYZ 三轴数组 `accel_g`、`gyro_dps` 和航向有效时的 `yaw_rate_dps`。`wheel_odom` 有效且反馈新鲜时提供 `t_ms`、`x_mm`、`y_mm`、`yaw_rad`。 |
| `battery_valid`、`battery_v`、`battery_percent`、`battery_low` | 后三项仅在电池数据新鲜时出现。 |
| `lidar_required`、`lidar_valid` | 配置了雷达或要求雷达联锁时出现。 |
| `max_wake_us`、`max_loop_us`、`overruns` | 控制任务最大唤醒延迟、最大循环耗时（微秒）和超时计数。 |

## 诊断与 Wi-Fi 配置

这些操作需要有效 `session`。Wi-Fi 变更采用异步任务，成功应答表示任务已入队，客户端轮询 `wifi_status` 获取最终结果。

| `op` | 请求与应答 |
| --- | --- |
| `imu_probe` | 无业务参数。底盘被占用时返回 `BUSY`。可返回 I²C 地址 `address` 和器件标识 `who_am_i`。 |
| `drive_log` | 无参数时返回最新日志号 `latest`、`saving`、`write_failed`。下载时指定 `run`、可选字节偏移 `offset`（默认 0），按顺序拼接 `csv`，用 `next` 作为下次偏移，直到 `eof: true`。每段最多 768 字节，保留最近 24 次记录。 |
| `wifi_status` | 返回 `hotspot`、`hotspot_on`、`home_ssid`、`home_ip`、`busy`、`setup_allowed`、`scan_allowed`、`message`、`networks` 和 `scan_state`（`idle`、`running`、`done`、`failed`）。 |
| `wifi_scan` | 空闲时可从热点或局域网发起。返回的扫描结果位于后续状态的 `networks`，最多 16 个不同的非空 SSID。 |
| `wifi_test` | 必填字符串 `ssid`（1–32 字节）和 `password`（0–64 字节，开放网络传空字符串），均不能含 NUL。WebSocket 连接须来自小车热点接口。连接测试成功后才保存，失败保留原配置。 |
| `wifi_forget` | 从小车热点接口发起，忘记已保存网络并恢复热点。扫描、测试和忘记操作都要求控制权空闲。 |

## 错误与恢复

先检查应答的 `ok`。已经受理的动作可能稍后失败，此时查看动作的 `action_state`、`action_reason` 和底盘的 `settled`。

| `error` | 客户端处理 |
| --- | --- |
| `BAD_FRAME`、`VERSION_OR_ID`、`STALE_ID`、`SESSION` | 检查消息格式、版本和序号。会话失效时重新握手。 |
| `UNKNOWN_OP`、`TOPIC_OR_RATE`、`FIELDS`、`STEP`、`KEY`、`RANGE` | 核对能力、主题、字段类型、采样步骤、动作键、数值和实时速度上限。 |
| `BUSY`、`NOT_READY`、`NO_FEEDBACK`、`MODE`、`STOPPED` | 查询状态。检查控制权、静止条件、驱动反馈及租约模式。`STOPPED` 表示该命令被同时处理的停车请求抢占。 |
| `NOT_OWNER`、`STALE_WINDOW` | 控制权已失效时停止续期。若仍持有同一租约，`STALE_WINDOW` 应答可携带当前 `lease` 和 `window`，仅在操作仍有效时用新序号和新窗口继续。 |
| `CAL_REQUIRED`、`SCALE_REQUIRED`、`BAD_SAMPLE`、`IMU_NOT_READY` | 分别检查所需标定、距离尺度、采样方向和位移、IMU 静止校零及航向状态。 |
| `CONFLICT`、`UNKNOWN_RESULT` | 检查动作键是否重复用于不同请求，或结果是否已从历史移除。 |
| `HOTSPOT_REQUIRED` | 通过小车热点地址重新连接后执行网络配置。 |
| `LOG_BUSY`、`LOG_STORAGE`、`NO_RUN`、`LOG_READ` | 分别检查日志占用、存储、记录号及偏移。 |
| `IMU_NO_RESPONSE`、`IMU_UNEXPECTED_ID`、`IMU_CONFIG`、`IMU_NO_DATA` | 检查 IMU 接线、器件标识、配置或采样。 |

运行中的动作可能因 `timeout`、`feedback_lost`、`disconnect`、`imu_lost`、`wheel_stalled`、`overshoot`、`heading_deviation`、`lidar_interlock`、`action_timeout` 等原因结束。控制权丢失后应清除本地目标，等待新的操作者输入。

## 实现对照

- [WebSocket 接入与断线处理](../esp32-s3/src/transport/host.cpp)
- [消息解析、应答与事件](../esp32-s3/src/protocol/session.cpp)
- [租约窗口规则](../esp32-s3/src/control/lease_windows.h)及[控制状态机](../esp32-s3/src/runtime/controller.cpp)
- [Wi-Fi 请求](../esp32-s3/src/transport/network.cpp)及[日志分页](../esp32-s3/src/storage/drive_log.cpp)
- [Android 客户端消息分发](../esp32-android/www/src/connection.js)

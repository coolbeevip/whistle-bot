# 参考硬件与接线

| 部件 | 配置 |
| --- | --- |
| 主控 | ESP32-S3-DevKitC-1 v1.1，板载 RGB 灯接 GPIO38 |
| 底盘 | 双轮差速，带辅助轮；两个 12 V L520 编码减速电机，轮径 67.5 mm |
| 驱动板 | 亚博四路编码器电机驱动模块，左轮接 M3，右轮接 M4 |
| 惯性传感器 | 逐飞科技 IMU660RB，三轴加速度计和三轴陀螺仪；已通过 I²C 芯片识别 |
| 上位机与相机 | Raspberry Pi 3 Model B Rev 1.2，OV5647 摄像头接 CSI |
| 参考电池 | 12 V、4400 mAh 三串 18650 电池组，满充 12.6 V |

## 主控与驱动板接线

断电后按插座丝印接线。ESP32 通过 UART1 控制驱动板，串口为 115200、8N1。下表线色对应参考线束。

| 驱动板 UART 插座 | 线色 | ESP32-S3 排针 | 用途 |
| --- | --- | --- | --- |
| RX2 | 绿 | 17（GPIO17，UART1 TX） | 主控发送电机指令 |
| TX2 | 黄 | 18（GPIO18，UART1 RX） | 主控接收驱动板反馈 |
| GND | 黑 | G（GND） | 两板共地 |
| 5V | 红 | 留空，线头绝缘 | 调试时主控单独通过 USB 供电 |

电脑或树莓派通过 USB 数据线连接 ESP32 标有 **UART** 的口。该接法由 USB 给主控供电，电机由驱动板电源端子单独供电。电源红线接 `+`、黑线接 `−`。参考板端子标注上限为 12 V，参考电池满充可达 12.6 V；通电前应确认供电全程处于驱动板允许范围。

## IMU660RB 与 ESP32-S3 接线

断开 USB 和电池后，按模块背面丝印接线。本项目为 IMU 选用 I²C，GPIO8 作 SDA，GPIO9 作 SCL。排针顺序从标有 VCC 的一端开始。

| IMU660RB 排针 | ESP32-S3 排针 | 用途 |
| --- | --- | --- |
| VCC | 3V3 | 模块供电 |
| GND | GND（G） | 共地 |
| SCL/SPC | GPIO9（9） | I²C 时钟 |
| SDA/SDI | GPIO8（8） | I²C 数据 |
| SA0/SDO | GND（G） | 地址位拉低，7 位地址为 `0x6A` |
| CS | 3V3 | 选择 I²C 模式 |
| INT1、INT2 | 留空 | 首次调试用轮询读取 |

VCC 和 CS 共用 3V3，GND 和 SA0/SDO 共用地。首次验证时，用 ESP32 的 USB 供电即可。按 LSM6DSR 规格，先扫描地址 `0x6A`，再读寄存器 `WHO_AM_I`（`0x0F`），预期返回 `0x6B`。实机通过 USB 调用固件的 `imu_probe`，连续三次在 `0x6A` 读到 `0x6B`。固件独立采集芯片坐标系的三轴加速度（含重力，单位 g）和三轴角速度（°/s），控制台在 **Drive → Vehicle telemetry → IMU660RB** 以约 5 Hz 显示。[ST LSM6DSR 数据手册](https://www.st.com/resource/en/datasheet/lsm6dsr.pdf)

## 轮子映射与标定

参考底盘左电机与左编码器的方向符号均为 −1，右侧均为 +1。参考轮每圈约 212 mm，编码器读数约为左轮 1784、右轮 1782 ticks。更换电机、轮胎或通道后，分别核对方向并重新标定。[控制器标定步骤](controller.md#驾驶和标定)

## 厂家资料

- [乐鑫 ESP32-S3-DevKitC-1 v1.1 引脚表](https://docs.espressif.com/projects/esp-idf/zh_CN/v5.3/esp32s3/hw-reference/esp32s3/user-guide-devkitc-1.html)
- [亚博四路电机驱动板说明](https://www.yahboom.net/study/L-MD520/14228/)
- [亚博驱动板与 ESP32-S3 串口接线示例](https://www.yahboom.net/study/MD520/14110/)

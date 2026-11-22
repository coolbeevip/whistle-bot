# Whistle Bot

Whistle Bot 包含 ESP32-S3 固件、电脑端底盘调试控制台和树莓派上位机。ESP32-S3 根据编码器反馈控制两个 L520 电机；树莓派提供手机驾驶页面、摄像头预览及带输入时间戳的录像。只接 ESP32 时，也可以使用电脑上的独立控制台驾驶和标定。

## 选择运行方式

| 目标 | 所需组件 | 入口 |
| --- | --- | --- |
| 验证接线、标定轮距、控制电机 | ESP32-S3、亚博驱动板、编码器底盘 | [接线与参考硬件](docs/hardware.md) · [启动底盘控制台](esp32-console/README.md) · [控制器构建与调试](docs/controller.md) |
| 从手机查看现场画面、驾驶或录像 | 已配置的底盘、树莓派、CSI 摄像头、USB 数据线 | [安装树莓派服务](docs/installation.md) · [控制台使用指南](docs/console.md) |
| 让视觉模型分步执行自然语言任务 | 上述树莓派配置和兼容的 HTTP 模型端点 | [Auto 请求与响应](docs/console.md#auto-视觉驾驶) |

## 从源码开始

安装 PlatformIO Core 后，在仓库根目录构建控制器。此命令只编译固件。

```sh
pio run -d esp32-s3
```

首次通电前请核对驱动板输入电压、两板共地及电机通道。实际下载、串口握手和架空标定步骤见[控制器指南](docs/controller.md)。

## 代码导航

| 目录 | 职责 |
| --- | --- |
| [esp32-s3](esp32-s3/) | C++ 控制循环、标定、USB 与 WebSocket 协议 |
| [esp32-console](esp32-console/) | 在电脑上运行的底盘驾驶、标定和网络调试网页 |
| [raspberry-pi](raspberry-pi/) | 树莓派 HTTP/WebSocket 服务、摄像、录像、底盘串口桥及手机界面 |
| [tools](tools/) | 开发机验证工具与驾驶日志分析 |
| [docs](docs/) | 安装、使用、硬件基线和设计决策 |

底盘协议、实时任务边界和雷达扩展接口见[固件架构](docs/esp32-s3-architecture.md)。手机页面的交互与布局约定见[控制台风格指南](docs/rover-console-ui.md)。

## 参与开发

通过 [GitHub Issues](https://github.com/coolbeevip/whistle-bot/issues) 讨论问题和设计变更；贡献流程、测试入口和发布检查见[贡献指南](CONTRIBUTING.md)。

## 许可证

项目原创代码与文档采用 [Apache License 2.0](LICENSE)。发行声明见 [NOTICE](NOTICE)。

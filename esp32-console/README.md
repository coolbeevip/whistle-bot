# ESP32 Console

电脑端底盘调试控制台提供方向键、定距与定角驾驶、标定、遥测和 Wi-Fi 设置。浏览器通过 WebSocket 直连 ESP32，树莓派可独立运行。

## 启动

使用 Node.js 22，从仓库根目录运行：

```sh
cd esp32-console
npm start
```

打开 [本地控制台](http://127.0.0.1:8765/)。网页服务只监听电脑的回环接口。运行控制台只需 Node.js，Playwright 用于开发测试。

- **局域网**：在 **Settings → Controller address** 输入 ESP32 的 IP，点击 **Connect**。也可以在本地控制台 URL 后加 `?board=<ESP32-IP>`。浏览器会记住所选地址。
- **小车热点**：让电脑连接小车热点，再打开[热点控制台入口](http://127.0.0.1:8765/?board=192.168.4.1)。首次配置及 BOOT 恢复步骤见[控制器指南](../docs/controller.md)。
- **连接状态**：页面显示 **Connected** 后即可读取状态。固件接受来自 `http://127.0.0.1:8765` 和 `http://localhost:8765` 的浏览器连接，WebSocket 端点为 `ws://<ESP32-IP>/ws`。

修改页面后刷新浏览器即可加载新版本。浏览器回归测试与真机检查见[控制台验收](../docs/controller-acceptance.md)。

# ESP32 Android 应用

Whistle Bot 使用 Capacitor 8 打包，手机通过 WebSocket 直连小车，支持四向驾驶、定距与定角动作、标定、遥测和 Wi-Fi 设置。Android Studio 工程在 `android/`，应用内界面的源文件在 `www/`。

## 构建与安装

构建需要 Node.js 22 或以上、JDK 21 和 Android SDK 36。从仓库根目录运行以下命令。安装时请连接已开启 USB 调试的手机。

```sh
cd esp32-android
npm ci
npm run android:build
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

修改界面后再次构建即可打包。使用 Android Studio 时，先运行 `npm run android:sync`，再打开 `android/` 并运行应用。

## 连接小车

打开 **Whistle Bot** 会先看到已添加的小车。首次使用时，连接小车热点并在 **Add rover** 中识别车辆。点选卡片后 App 核对车辆身份，旧地址失效时通过 mDNS 查找同一辆车。

首次配置与热点恢复见[控制器指南](../docs/controller.md)。触控回归测试与真机检查见[验收说明](../docs/controller-acceptance.md)。

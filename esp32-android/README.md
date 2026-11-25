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

手机连接小车热点后打开 **Whistle Bot**，默认地址为 `192.168.4.1`。使用家庭热点或局域网时，将手机和小车接入同一网络，在 **Settings → Controller address** 输入小车的局域网 IP。应用会记住所选地址，显示 **Connected** 后即可查看遥测。

首次配置与热点恢复见[控制器指南](../docs/controller.md)。触控回归测试与真机检查见[验收说明](../docs/controller-acceptance.md)。

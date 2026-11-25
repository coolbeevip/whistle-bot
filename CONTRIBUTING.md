# 参与 Whistle Bot

## 讨论与评审

通过 GitHub Issues 描述可观察的现象、硬件型号、固件版本和重现条件。控制协议、接线默认值、持久化格式或驾驶行为的变更应在 issue 或 pull request 中说明兼容性与迁移方式。评审时围绕证据和实现展开讨论，尊重参与者。维护者在公开的 pull request 中记录决定及理由，合并变更并负责打标签发布。首次导入后的改动也遵循这套流程。

贡献前请确认你有权提交相关材料。原创贡献采用仓库的 Apache-2.0 许可证。引入第三方源码、图片或生成文件时，请标明来源、许可证与需要保留的声明。凭据、原始录像、家庭网络名称和设备标识应留在本地。涉及未公开漏洞时，先通过维护者 [GitHub 个人资料](https://github.com/coolbeevip)上的联系方式建立私密渠道。

## 本地验证

从仓库根目录运行以下检查。宿主机需要 C++17 编译器、Node.js 及 Python 3.11 或以上版本。Python 测试使用摄像头替身，可在开发机或 CI 运行。

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install pyserial -r raspberry-pi/requirements.txt
sh tools/check.sh
```

Android 应用的手机触控、精确运动、标定和停车行为由浏览器验收测试覆盖。安装、运行与真机检查见[控制台验收](docs/controller-acceptance.md)。

修改固件或其依赖后，编译 ESP32-S3 控制器固件。

```sh
pio run -d esp32-s3
```

Android 应用开发从 `esp32-android/` 开始。树莓派网页开发从 `raspberry-pi/index.html` 和同目录的 `static/` 开始。在目标树莓派启动服务的步骤见[安装说明](docs/installation.md)。提交界面变更时附手机截图，并说明横竖屏与触控检查结果。提交运动控制变更时区分宿主机模拟、架空测试和落地测量，并记录适用的电机通道与标定状态。

## 发布

维护者从干净检出验证宿主机测试与控制器固件构建，复核 LICENSE、NOTICE、依赖和归档清单。在 GitHub Release 说明兼容硬件、变更、已验证范围与已知限制。发布固件二进制前，单独检查实际链接的依赖及其再分发声明。版本标签指向通过验证的提交。

项目以公开讨论和可追溯的技术决策组织协作。治理和发行文件的编写参考 [ASF 项目协作说明](https://www.apache.org/foundation/how-it-works/)与 [LICENSE 和 NOTICE 指南](https://infra.apache.org/licensing-howto.html)。

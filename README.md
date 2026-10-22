# DeepSeek Harness for Android

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) 装进 Android 的独立 App：**装完就能用，不需要 Termux、不需要 root、不需要电脑**。

引擎（Node.js 运行时 + DSH 本体）随安装包一起分发，首启解包到 App 私有目录，之后所有对话、工具调用、终端、内置浏览器都在 App 内部跑。

## 下载

到 [Releases](../../releases) 页面，按版本号挑最新的 `dsh-harness-<version>-arm64.apk`（同一页附 `.sha256`）。

> 版本策略：调试期用 `0.x`（目前全部标为 pre-release）；**等登录、更新、日常使用都稳了，才发 `1.0.0` 正式版**。

## 安装

1. 下载 APK（约 243 MB，建议 Wi-Fi）
2. 点击安装，首次需要允许「安装未知应用」
3. 首次启动会自动解包运行环境（**约 60 秒**，889 MB），期间请不要退出
4. 进入后用 DeepSeek 账号登录，或填自己的 API Key

### 校验安装包（可选，推荐）

```bash
sha256sum dsh-harness-*-arm64.apk   # 换成你实际下到的文件名
# 与 Release 页面里 .sha256 文件的内容对比
```

## 环境要求

| 项 | 要求 |
|---|---|
| Android | 8.0（API 26）及以上 |
| CPU | arm64-v8a |
| 存储 | 约 1.2 GB（243 MB 安装包 + 889 MB 运行环境） |
| 网络 | 首次登录需要联网；之后离线也能开旧会话，新对话需要联网 |

## 数据与隐私

- 对话记录、工作区文件、登录凭据全部保存在 App 私有目录（`/data/data/dev.dsh.harness/files/`），其他应用无法读取
- 凭据文件权限为 `600`，只有本 App 能读
- 卸载 App 即删除全部数据（含对话记录），升级 App 不会
- 与模型服务的通信由 DSH 直接发起，不经过任何中转服务器
- 外壳层（本项目代码）不含任何统计、埋点或遥测

## 已知限制

- **常驻通知**：Android 要求有前台服务才能长期后台运行，通知栏会一直有一条「DeepSeek Harness」，可以在通知上点「停止引擎」
- 首次启动解包较慢，属于一次性成本
- 引擎只监听本机 `127.0.0.1:3082`，不对外暴露端口

## 常见问题

**装完打不开 / 闪退？** 先确认是 arm64 设备（绝大多数 2019 年后的机器都是）。首次启动若在解包阶段退出，重新打开会从头解包。

**一直显示「正在唤醒大肥鱼」？** 说明引擎没起来。下拉通知看有没有错误提示，或在 App 内重新启动；仍未解决请附上 `logs/` 目录下的诊断文件开 issue。

**换了手机怎么迁移对话？** 目前数据只在 App 私有目录，暂不支持导出。需要的话可以提 issue。

**流量会很大吗？** 安装包 243 MB 只能整包下载；日常对话走模型 API，不吃额外流量。

## 从源码构建

在 Android 上的 Termux 里（需要 `aapt2`、`d8`、`apksigner`、`javac`）：

```bash
# 1. 取上游运行时快照（Termux arm64 包 + 官方 DSH）
#    见 repack-rootfs.sh 头部注释
# 2. 重打包成 App 用的载荷
bash repack-rootfs.sh ../refs/snapshot/full
# 3. 构建 + 出包（载荷会以 ZIP_STORED 内嵌进 APK）
bash build-apk.sh
```

## 许可证

- 本项目（Android 外壳层）：MIT，见 [LICENSE](LICENSE)
- `@deepseek-ai/dsh`：MIT
- 随包分发的运行时组件（Node.js、bash、coreutils 等，来自 Termux 仓库）：GPL-2.0 / GPL-3.0 / LGPL-2.1 / LGPL-3.0 等，详见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)

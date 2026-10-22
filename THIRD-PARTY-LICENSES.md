# 第三方组件与许可证

本 App 的安装包内嵌了一份运行时载荷（`assets/dshb-rootfs.tar.gz`，解包后约 889 MB），
其中除 DeepSeek Harness 本体外，还包含从 **Termux 官方仓库**（`packages.termux.dev`，aarch64 包）
提取的可执行程序与库。分发这些二进制时需保留各自的许可证与源码获取途径。

## 1. DeepSeek Harness

- 包名：`@deepseek-ai/dsh`
- 版本：`0.2.1-rc.2`
- 许可证：**MIT**
- 来源：<https://www.npmjs.com/package/@deepseek-ai/dsh>

其依赖（`dsh/node_modules/` 下 600+ 个包）各自沿用原许可证，包含 MIT、Apache-2.0、ISC、BSD 等。
完整许可证文本随载荷保留在各自包的目录中。

## 2. Termux 运行时组件

以下组件从 Termux 仓库的 aarch64 `.deb` 中提取，**未修改二进制内容**：

| 组件 | 用途 | 典型许可证 |
|---|---|---|
| `nodejs-lts`（Node.js 24.18.0） | 运行 DSH | MIT + 其内置依赖（OpenSSL: Apache-2.0、V8: BSD-3-Clause 等） |
| `bash` | 终端与脚本 | GPL-3.0-or-later |
| `coreutils` | 基础命令 | GPL-3.0-or-later |
| `findutils` / `grep` / `sed` / `diffutils` | 命令行工具 | GPL-3.0-or-later |
| `tar` / `xz-utils` / `zstd` | 归档与压缩 | GPL-3.0 / GPL-2.0 / BSD 双许可 |
| `ripgrep`（`rg`） | 代码搜索 | MIT / Unlicense |
| `libandroid-support` / `libiconv` | 兼容库 | LGPL-2.1 / LGPL-3.0 |
| 其他依赖库（ncurses、readline、openssl 等） | 运行时依赖 | 见下表 |

许可证全文随 App 一起分发，位于：

```
/data/data/dev.dsh.harness/files/usr/share/LICENSES/
  GPL-2.0.txt  GPL-3.0.txt  LGPL-2.1.txt  LGPL-3.0.txt  Shizuku-API-MIT.txt
```

### 源码获取

GPL / LGPL 组件的源码可从 Termux 的构建仓库获取：

- 包索引与二进制：<https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/>
- Termux 包构建脚本（含每个包的源码 URL 与版本）：<https://github.com/termux/termux-packages>

如需本项目所分发版本的精确对应源码，请在本仓库开 issue，我们按版本提供下载链接。

## 3. 本项目外壳层

`app/src/main/java/` 下的 Java 代码、`build-apk.sh`、`repack-rootfs.sh` 等构建脚本由本项目作者编写，
许可证为 **MIT**（见 `LICENSE`）。

## 4. 商标

「DeepSeek」为杭州深度求索人工智能基础技术研究有限公司的商标。本项目为非官方打包，
与 DeepSeek 官方无隶属或背书关系；使用本 App 产生的模型调用费用与数据处理遵循你所用账号的服务条款。

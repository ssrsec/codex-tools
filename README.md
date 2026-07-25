<div align="center">
  <h1>Codex Tools</h1>
  <p><strong>Codex 多账号管理、CLI/TUI 切换、用量查看和本地 OpenAI 兼容 API 反代工具。</strong></p>
  <p>
    <a href="https://github.com/ssrsec/codex-tools/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/ssrsec/codex-tools?label=release"></a>
    <a href="https://www.npmjs.com/package/@ssrsec/ctc"><img alt="npm" src="https://img.shields.io/npm/v/@ssrsec/ctc?label=npm"></a>
    <a href="https://github.com/ssrsec/codex-tools/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue"></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey">
  </p>
</div>

> [!IMPORTANT]
> 本仓库基于 [170-carry/codex-tools](https://github.com/170-carry/codex-tools) 开源项目开发，遵循原项目的 MIT 许可证。当前版本由 [ssrsec/codex-tools](https://github.com/ssrsec/codex-tools) 独立维护，后续功能、修复、Issue 和 Release 均以本仓库为准，不再自动跟随原仓库更新。

## 项目简介

Codex Tools 面向同时使用多个 Codex 账号的场景，提供桌面 GUI、CLI/TUI 和本地 `/v1` 反代能力。你可以导入账号、检测账号健康状态、查看一周额度与有效 Token、切换本机 Codex 登录态，也可以把健康账号池暴露成 OpenAI 兼容接口供 Cursor、ChatWise、CC Switch、本地脚本等工具调用。

## 目录

- [主要功能](#主要功能)
- [安装](#安装)
- [快速开始](#快速开始)
- [CLI 命令](#cli-命令)
- [API 反代](#api-反代)
- [开发](#开发)
- [发布](#发布)
- [文档](#文档)
- [常见问题](#常见问题)
- [项目来源与许可](#项目来源与许可)

## 主要功能

- 多账号管理：OAuth 登录导入、JSON 批量导入、账号备份与回导入。
- 健康检测：识别授权失效、账号停用、Free 套餐、额度耗尽与临时检测失败，支持单账号检测和一键清理确定不可用账号。
- 用量查看：展示当前一周额度、订阅到期、下次重置、有效 Token 与平均周使用率。
- 快速切换：切换 `~/.codex/auth.json` 和 `config.toml`，可联动启动新版 ChatGPT App，并兼容旧 Codex App 与 `codex app` 回退。
- CLI/TUI：通过 `ctc` 执行 `list/switch/login/import/export/usage/provider/doctor/report/tui`。
- API 反代：本地提供 OpenAI 兼容 `/v1` 接口，自动排除不可用账号，并支持请求失败后的冷却、重试和运行中账号轮换。
- App/CLI 绑定：可一键把 Codex App/CLI 切到本机反代地址，也可一键恢复原配置。
- 用量分析：按主会话统计有效 Token、项目、会话、Prompt 和七日热力图，并按官方标准 API 费率给出等价成本估算。
- 公网访问：集成 cloudflared，支持快速隧道和命名隧道。
- 桌面能力：状态栏驻留、多语言界面、编辑器联动。
- 更新方式：应用不包含自动更新器，新版本请从本仓库 Releases 下载。

## 安装

### CLI/TUI

推荐通过 npm 安装命令行入口：

```bash
npm i -g @ssrsec/ctc
```

安装后使用：

```bash
ctc list --json
ctc switch --best --launch
ctc provider status --json
ctc tui
ctc ui
```

不想全局安装时，可以直接运行：

```bash
npx @ssrsec/ctc list --json
```

`ctc ui` 会打开本机已安装的 Codex Tools 桌面应用；npm 包负责安装命令行入口和原生 CLI，不负责安装 `.app` 或 `.exe` 桌面包。

### 桌面应用

桌面应用从 GitHub Releases 下载：

- [下载最新版本](https://github.com/ssrsec/codex-tools/releases/latest)
- macOS Apple Silicon / Intel
- Windows x64

安装桌面应用后，可以直接在 GUI 内完成账号导入、用量刷新、切换、API 反代和 cloudflared 配置。

## 快速开始

### 终端

```bash
ctc login --label work
ctc list --refresh --json
ctc switch --best --launch
ctc provider sync
ctc doctor --json
```

常见流程：

1. 用 `ctc login` 调用官方 `codex login` 并导入账号。
2. 用 `ctc list --refresh` 查看账号和用量。
3. 用 `ctc switch 1` 或 `ctc switch --best` 切换账号。
4. 用 `ctc provider sync` 修复 Codex 历史 provider 元数据。
5. 用 `ctc doctor` 检查本机环境和账号库状态。

### 桌面应用

1. 打开 Codex Tools。
2. 导入一个或多个 Codex 账号。
3. 刷新用量，查看账号状态、一周额度、订阅信息和下次重置时间。
4. 对有疑问的账号单独执行状态检测，确定不可用时可使用一键清理。
5. 选择可用账号切换，或启动会自动过滤异常账号的本地 API 反代。
6. 需要公网访问时，再开启 cloudflared。

## CLI 命令

所有命令默认读取桌面应用相同的数据目录。需要隔离环境时，加 `--data-dir <目录>`。

| 命令 | 说明 |
| --- | --- |
| `ctc list --json` | 列出已保存账号，输出 JSON |
| `ctc list --refresh --json` | 刷新用量后列出账号 |
| `ctc switch 1 --json` | 切换到第 1 个账号 |
| `ctc switch --best --launch` | 按余量选择更合适的账号，并启动 `codex app` |
| `ctc login --label work` | 调用官方 `codex login`，登录后自动导入账号 |
| `ctc import ./auth.json --json` | 导入账号 JSON |
| `ctc import ./accounts-dir --json` | 导入目录中的账号 JSON |
| `ctc import --current --json` | 导入当前 `~/.codex/auth.json` |
| `ctc export ./accounts.json --json` | 导出账号库 |
| `ctc export --json` | 直接把账号库 JSON 输出到终端 |
| `ctc usage --cached --json` | 查看本地缓存用量 |
| `ctc provider status --json` | 查看当前 provider、rollout 和 `state_5.sqlite` provider 统计 |
| `ctc provider sync` | 把本机 Codex 历史元数据同步到当前 provider |
| `ctc provider switch openai` | 写入 `model_provider = "openai"` 并同步历史元数据 |
| `ctc provider restore` | 恢复最近一次 provider 同步前备份 |
| `ctc doctor --json` | 检查数据目录、Codex CLI、账号库和本机 auth 文件 |
| `ctc report --json` | 输出完整诊断报告 |
| `ctc tui` | 打开终端账号选择器 |
| `ctc ui` | 打开已安装的 Codex Tools 桌面应用 |

`ctc provider sync` 会在 `~/.codex/backups_state/provider-sync/` 下生成备份；包含 `encrypted_content` 的历史会恢复列表可见性，但跨 provider 继续 resume 仍可能受 Codex 加密上下文限制。

## API 反代

Codex Tools 可以启动本地 OpenAI 兼容反代：

- 默认地址：`http://127.0.0.1:8787/v1`
- 鉴权方式：应用内生成的 `sk-...` API Key
- 上游来源：已导入的 Codex 账号
- 账号选择：自动排除授权失效、Free、额度耗尽及冷却中的账号，按当前一周额度选择并支持运行中切换
- 默认模型：`gpt-5.6-sol`
- 默认推理：`xhigh` + `fast`
- GPT-5.6 模型：`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`

更多链路说明见 [docs/api-proxy.md](docs/api-proxy.md)。

### 本地客户端

本地脚本、`curl`、ChatWise 等本机直连客户端，可以直接使用本地 `Base URL`：

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-..."
```

### Cursor

Cursor 可能由服务端代发请求，不建议填写 `127.0.0.1`、`localhost`、`192.168.x.x`、`10.x.x.x` 等本地或私网地址。

如果 Cursor 报 `ssrf_blocked` 或 `connection to private IP is blocked`，请改用：

- 应用内 cloudflared 生成的 `Public URL`
- 远程 Linux 反代地址
- 自己的公网域名反向代理地址

模型名称建议使用 `gpt-5.6-sol`。`gpt-5.6`、`gpt5.6` 和 `gpt-5-6` 会映射到 Sol，Terra/Luna 也兼容无点号和全连字符别名。

GPT-5.6 可用推理强度为 `none`、`low`、`medium`、`high`、`xhigh`、`max`；代理还保留 `minimal` 供旧模型兼容。可用速度为 `auto`、`default`、`fast`、`flex`，其中 `fast` 会按上游 wire 值 `priority` 发送。

### CC Switch

在 CC Switch 的 Codex 自定义 provider 中填写：

- `Base URL`：`http://127.0.0.1:8787/v1`
- `API Key`：应用内生成的 `sk-...`
- `wire_api`：`responses`

如果 Codex App/CLI 通过 wrapper、app bind、CC Switch 或自定义 provider 指向这个 `Base URL`，账号轮换会发生在本地反代层，不需要关闭 Codex App/CLI。

反代面板也提供“切到本机反代”和“恢复正常地址”按钮，会自动备份并恢复 `~/.codex/config.toml` 与 `~/.codex/auth.json`。

### Anthropic Messages 兼容

兼容 Anthropic Messages 的客户端可以请求：

- 地址：`http://127.0.0.1:8787/v1/messages`
- Key：`x-api-key: sk-...`
- 版本：`anthropic-version: 2023-06-01`

这里的 `2023-06-01` 是 Anthropic API version，不是模型版本日期。

## 开发

### 环境要求

- Node.js 20+
- Rust stable
- macOS 或 Windows

### 本地运行

```bash
npm install
npm run tauri dev
```

### 构建 CLI

```bash
cd src-tauri
cargo build --bin codex-tools-cli
```

### 构建前端

```bash
npm run build
```

## 发布

本仓库使用 GitHub Actions 自动发布桌面安装包和 npm CLI 包。

触发发布：

```bash
git tag v<version>
git push origin v<version>
```

发布内容：

- macOS Apple Silicon 桌面安装包
- macOS Intel 桌面安装包
- Windows x64 桌面安装包
- npm wrapper：`@ssrsec/ctc`
- npm native packages：`@ssrsec/ctc-darwin-arm64`、`@ssrsec/ctc-darwin-x64`、`@ssrsec/ctc-win32-x64`

npm 发布需要在 GitHub repository secrets 中配置 `NPM_TOKEN`。

应用已移除内置自动更新器和签名密钥依赖。用户通过本仓库 Releases 或 npm 获取新版本。

## 文档

- [使用说明](how%20to%20use.md)
- [API 反代说明](docs/api-proxy.md)
- [Linux Proxyd](docs/linux-proxyd.md)
- [更新日志](changelog.md)

## 常见问题

### npm 安装后缺少原生包

如果安装时禁用了 optional dependencies，可能会看到缺少平台包的提示。重新安装：

```bash
npm i -g @ssrsec/ctc --include=optional
```

### macOS 提示应用已损坏

如果 macOS 拦截未签名或隔离属性残留的应用，可以执行：

```bash
sudo spctl --master-disable
sudo xattr -r -d com.apple.quarantine /Applications/Codex\ Tools.app
```

### Cursor 无法访问本地地址

如果 Cursor 返回 `ssrf_blocked`，说明它的请求侧无法访问本机私网地址。请使用 cloudflared、远程 Linux 反代或公网域名。

## 项目结构

```text
src/                     React frontend
src-tauri/               Tauri and Rust backend
src-tauri/src/bin/       Native CLI binaries
npm/                     npm wrapper and platform packages
docs/                    Extra documentation
.github/workflows/       Release workflows
```

## Star 历史

<a href="https://www.star-history.com/?repos=ssrsec/codex-tools&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=ssrsec/codex-tools&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=ssrsec/codex-tools&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=ssrsec/codex-tools&type=date&legend=top-left" />
 </picture>
</a>

## 项目来源与许可

- 原始项目：[170-carry/codex-tools](https://github.com/170-carry/codex-tools)
- 当前独立维护仓库：[ssrsec/codex-tools](https://github.com/ssrsec/codex-tools)
- 本仓库不会自动同步原仓库；如需引入上游变更，会先独立审查和测试。
- 项目继续使用 MIT 许可证，原作者版权与许可声明予以保留，详见 [LICENSE](LICENSE)。

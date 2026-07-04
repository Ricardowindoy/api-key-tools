# API Key Manager

跨平台桌面应用，统一管理多个 AI 平台的 API Key 与模型选择，支持一键复制请求地址。提供常驻桌面小组件，无需打开主窗口即可快速切换 Key 和模型。

**支持任意厂商**：可手动添加任意兼容 OpenAI API 格式的 AI 服务商（如 OpenAI、StepFun、OpenCode、Anthropic、DeepSeek 等）。

基于 **Tauri 2** 重构，使用 Rust 后端 + 原生 HTML/CSS/JS 前端，安装体积仅约 10-20MB（相比 Electron 版减少 80%+）。

## 功能

### 密钥管理
- 支持任意厂商，自由添加 / 删除
- 每个厂商独立管理多个 API Key
- 添加 / 切换 / 删除 API Key
- 一键复制 Key 值到剪贴板
- Key 选中状态持久化

### 模型管理
- 实时拉取服务端模型列表（`/v1/models` 标准接口）
- 切换模型后选中状态持久化
- Base URL 支持自由修改

### 桌面小组件
- 常驻桌面，鼠标悬停自动展开，移出后自动收起
- **边缘吸附**：收起后自动平滑滑向最近屏幕边缘（easeOutCubic 缓动）
- 原生窗口拖动，位置持久化（多显示器适配）
- 收起态带渐变光环 + 钥匙图标呼吸动画
- 支持深色 / 浅色主题切换
- 开机自启开关（基于 tauri-plugin-autostart）

### 多端同步配置（非对称加密）
通过指定 URL 在多设备间同步配置，全部数据采用混合加密：

- **加密方案**：RSA-2048-OAEP (SHA-256) 包裹 AES-256-GCM 密钥
- **密钥管理**：生成 / 导入 / 导出 PEM 格式密钥对，私钥仅本地保存
- **同步方式**：从任意 HTTP(S) URL 拉取加密配置 → 解密 → 合并或覆盖本地
- **合并策略**：按 Key ID 合并，远端覆盖同 ID 的本地 Key，保留本地新增
- **自动同步**：可选 1/5/15/30/60 分钟间隔静默合并
- **加密导出**：将本地配置加密后下载为 `.enc.json`，可上传到任意静态托管

### 一键复制
所有关键信息均可点击复制：

| 元素 | 示例 |
|------|------|
| API Key | `sk-test123` |
| 模型 ID | `step-3.7-flash` |
| Base URL | `https://api.stepfun.com/v1` |
| 完整请求地址 | `https://api.stepfun.com/v1/chat/completions` |

### 主题
- 深色 / 浅色主题，主窗口与小组件联动
- 主题设置持久化，下次启动自动恢复

## 架构

```
┌────────────────────────────────────────────────┐
│              Tauri 应用 (Rust 主进程)            │
│                                                 │
│  ┌─────────────┐        ┌─────────────────┐    │
│  │ Webview 主窗 │        │ Webview Widget  │    │
│  │ (index.html) │        │ (widget.html)   │    │
│  └──────┬──────┘        └────────┬────────┘    │
│         │                        │              │
│         └──────────┬─────────────┘              │
│                    │ invoke (IPC)               │
│         ┌──────────┴──────────┐                 │
│         │ Rust 后端 (lib.rs)  │                 │
│         │  - config 读写      │                 │
│         │  - models HTTP 拉取 │                 │
│         │  - 窗口/主题管理    │                 │
│         └─────────────────────┘                 │
└────────────────────────────────────────────────┘
```

相比原 Electron 架构：
- **不再需要 HTTP 服务器**：前端通过 `invoke` 直接调用 Rust 函数
- **不再需要 preload 桥接**：Tauri 内置安全的 IPC 机制
- **体积大幅减小**：使用系统 WebView，不打包完整 Chromium

## 使用

### 前置要求

- Rust >= 1.77
- Node.js >= 18（仅用于前端工具链，非运行时依赖）

**平台额外要求：**

| 平台 | 依赖 |
|------|------|
| Windows | WebView2（Win10/11 通常已内置） |
| macOS | 系统自带 WebKit |
| Linux | `libwebkit2gtk-4.1-dev`、`librsvg2-dev`、`patchelf` |

### 开发运行

```bash
# 安装 Tauri CLI
cargo install tauri-cli --version "^2.0" --locked

# 开发模式（带热重载）
cargo tauri dev

# 生产构建
cargo tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`。

### 打包目标

| 平台 | 产物 |
|------|------|
| Windows | `.exe` (NSIS) / `.msi` |
| macOS | `.dmg` / `.app` |
| Linux | `.deb` / `.AppImage` / `.rpm` |
| Android | `.apk`（debug，免签名） |
| iOS | `.app` / `.ipa`（未签名） |

### 移动端构建

```bash
# Android（需要 JDK 17 + Android SDK 34 + NDK r26d）
cargo tauri android init
cargo tauri android build --apk --debug

# iOS（需要 Xcode + Rust iOS targets）
cargo tauri ios init
cargo tauri ios build --no-sign
```

移动端注意事项：
- 仅创建主窗口，widget 窗口配置在移动端被忽略
- `tauri-plugin-autostart` 仅桌面端注册（移动端无此概念）
- iOS 完整 Xcode 构建因签名证书可能失败，CI 中先用 `cargo build --target aarch64-apple-ios` 验证 Rust 编译

## 项目结构

```
api-key-tools/
├── src-tauri/
│   ├── Cargo.toml          # Rust 依赖与构建配置
│   ├── tauri.conf.json     # Tauri 应用配置（窗口、打包、权限）
│   ├── build.rs            # Tauri 构建脚本
│   ├── capabilities/
│   │   └── default.json    # 权限配置（窗口操作、自启动等）
│   └── src/
│       ├── main.rs         # 程序入口
│       ├── lib.rs          # 应用主逻辑 + Tauri commands
│       ├── config.rs       # 配置文件读写（多厂商支持）
│       ├── models.rs       # HTTP 模型拉取（reqwest）
│       ├── state.rs        # 窗口状态/主题/同步配置持久化
│       └── sync.rs         # 多端同步：RSA + AES 混合加密
├── public/
│   ├── index.html          # 主窗口入口
│   ├── app.js              # 主窗口 UI 逻辑（invoke 调用）
│   ├── style.css           # 主窗口样式
│   ├── widget.html         # 小组件入口
│   ├── widget.js           # 小组件 UI 逻辑（invoke 调用）
│   ├── widget.css          # 小组件样式
│   └── favicon.svg         # 应用图标
├── build/
│   ├── icon.png            # 应用图标（PNG）
│   └── logo.svg            # 图标源文件（SVG）
├── .github/workflows/
│   └── build.yml           # GitHub Actions 五平台构建（Linux/Windows/macOS/Android/iOS）
└── README.md
```

## IPC 接口

前端通过 `window.__TAURI__.core.invoke` 调用 Rust 后端命令：

| 命令 | 参数 | 说明 |
|------|------|------|
| `get_config` | - | 读取完整配置 |
| `save_config` | `config` | 全量保存配置 |
| `save_select` | `provider, keyId?, modelId?` | 定向更新选中项 |
| `get_widget_view` | - | 获取 widget 简化视图 |
| `fetch_models_command` | `provider, baseUrl, key` | 拉取模型列表 |
| `get_theme` | - | 获取主题 |
| `set_theme` | `theme, scope?` | 设置主题 |
| `get_widget_position` | - | 获取 widget 位置 |
| `save_widget_position` | `x, y` | 保存 widget 位置 |
| `reset_widget_position` | - | 重置 widget 位置 |
| `widget_set_expanded` | `expanded` | 切换 widget 展开 |
| `widget_snap_to_edge` | - | 收起态吸附到最近屏幕边缘 |
| `widget_show` | - | 显示 widget |
| `widget_hide` | - | 隐藏 widget |
| `get_app_version` | - | 获取应用版本号 |
| `sync_generate_keypair` | - | 生成 RSA-2048 密钥对 |
| `sync_get_state` | - | 获取同步状态 |
| `sync_set_url` | `url?` | 设置/清除同步 URL |
| `sync_set_auto_interval` | `minutes?` | 设置自动同步间隔 |
| `sync_import_private_key` | `privatePem` | 导入私钥（自动推导公钥） |
| `sync_import_public_key` | `publicPem` | 导入公钥 |
| `sync_clear_keys` | - | 清除密钥 |
| `sync_encrypt_config` | - | 加密当前配置返回 JSON |
| `sync_fetch_remote` | - | 从 URL 拉取并解密配置 |
| `sync_merge_config` | `remote` | 合并远端配置到本地 |
| `sync_overwrite_config` | `remote` | 用远端配置覆盖本地 |

## 配置

配置文件存储在系统 AppData 目录：

| 平台 | 路径 |
|------|------|
| Windows | `%APPDATA%\com.apikeymanager.app\` |
| macOS | `~/Library/Application Support/com.apikeymanager.app/` |
| Linux | `~/.config/com.apikeymanager.app/` |

包含四个文件：
- `config.json` — 厂商配置（base_url、keys、selected_model）
- `widget-state.json` — widget 位置与主题
- `app-state.json` — 主窗口主题
- `sync-state.json` — 同步配置（URL、密钥对、自动同步间隔、同步记录）

配置文件以厂商标识为顶层 key，每个厂商结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `base_url` | string | API 地址 |
| `keys[]` | array | API Key 列表 |
| `keys[].id` | string | Key 唯一标识 |
| `keys[].name` | string | 显示名称 |
| `keys[].key` | string | API Key 值 |
| `keys[].selected` | boolean | 是否为当前选中 |
| `selected_model` | string | 当前选中的模型 ID |

## 体积对比

| 框架 | 安装包体积 | 安装后体积 |
|------|----------|----------|
| Electron (旧版) | ~60-80 MB | ~150-200 MB |
| **Tauri (新版)** | **~5-15 MB** | **~10-20 MB** |

## CI/CD

GitHub Actions 自动构建五平台并发布 Release：

- 推送到 `master`/`main`：构建 + 发布 Release
- 推送到 `dev`：仅构建（产 artifact）
- PR：仅构建验证

构建矩阵：
- `ubuntu-22.04` → Linux `.deb` / `.AppImage`
- `windows-latest` → Windows `.exe` / `.msi`
- `macos-latest` → macOS `.dmg`
- `android`（ubuntu-22.04）→ `.apk`（debug）
- `ios`（macos-latest）→ `.app` / `.ipa`（未签名）

## 同步使用流程

**A 设备（源）：**
1. 点「🔄 同步」→「生成密钥对」
2. 点「⬆ 导出加密配置」下载 `.enc.json`
3. 将文件上传到任意静态 URL（GitHub Gist、云存储、自建服务等）
4. 复制公钥/私钥，分享给 B 设备

**B 设备（目标）：**
1. 点「🔄 同步」→「导入私钥」（粘贴 A 设备的私钥）
2. 填写同步 URL（步骤 3 的地址）
3. 点「⬇ 从 URL 拉取」→ 选择「合并」或「覆盖」
4. 可选：开启自动同步

## 许可证

GPLv3

# API Key Manager

Electron 桌面应用，统一管理多个 AI 平台的 API Key 与模型选择，支持一键复制请求地址。提供常驻桌面小组件，无需打开主窗口即可快速切换 Key 和模型。

**支持任意厂商**：可手动添加任意兼容 OpenAI API 格式的 AI 服务商（如 OpenAI、StepFun、OpenCode、Anthropic、DeepSeek 等）。

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
- 拖动任意位置，关闭后重新打开恢复上次位置（多显示器适配）
- 支持深色 / 浅色主题切换
- 开机自启开关

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
│                 Electron 主进程 (main.js)        │
│  ┌──────────────┐         ┌──────────────────┐  │
│  │ BrowserWindow │         │ BrowserWindow     │  │
│  │ (主窗口)      │         │ (小组件/Widget)  │  │
│  └──────┬───────┘         └────────┬─────────┘  │
│         │                          │            │
│  ┌──────┴───────┐         ┌────────┴─────────┐  │
│  │ app-preload  │         │ widget-preload   │  │
│  └──────┬───────┘         └────────┬─────────┘  │
│         └──────────┬───────────────┘            │
│                    │ IPC                         │
│         ┌──────────┴──────────┐                  │
│         │  HTTP 服务器        │                  │
│         │  (server.js)        │                  │
│         │  :39871             │                  │
│         └────────────────────┘                  │
└────────────────────────────────────────────────┘
```

## 使用

### 前置要求

- Node.js >= 18
- npm

### 安装与运行

```bash
# 安装依赖
npm install

# 开发模式运行
npm start
```

### 打包

```bash
# 打包 Windows 安装包 (NSIS)
npm run build:win

# 打包后安装包输出到 build-dist/ 目录
```

> 也可使用项目根目录下的 `build.bat` 脚本（Windows），会自动处理 Electron 下载（使用淘宝镜像）并执行打包。

## 项目结构

```
api-key-tool/
├── main.js              # Electron 主进程 — 窗口管理、IPC 处理
├── server.js            # HTTP 服务器 — 静态文件 + REST API
├── logger.js            # 日志模块 — 控制台 + 文件 (app.log)
├── widget-preload.js    # 小组件渲染进程 IPC 桥接
├── app-preload.js       # 主窗口渲染进程 IPC 桥接
├── config.json          # 初始配置文件（含示例数据）
├── package.json         # 项目配置与打包脚本
├── build.bat            # Windows 打包辅助脚本
├── public/
│   ├── index.html       # 主窗口入口
│   ├── app.js           # 主窗口 UI 逻辑
│   ├── style.css        # 主窗口样式
│   ├── widget.html      # 小组件入口
│   ├── widget.js        # 小组件 UI 逻辑
│   └── widget.css       # 小组件样式
└── README.md
```

## API 文档

HTTP 服务器运行在 `http://localhost:39871`。

### 配置管理

#### `GET /api/config`

返回当前完整的配置文件内容（JSON）。每个 key 为厂商标识，value 包含该厂商的 Base URL、Keys 列表和选中的模型。

响应示例：

```json
{
  "stepfun": {
    "baseUrl": "https://api.stepfun.com/v1",
    "keys": [
      { "id": "k1", "name": "测试号", "key": "sk-xxx", "selected": true }
    ],
    "selectedModel": "step-3.7-flash"
  },
  "opencode": {
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "keys": [],
    "selectedModel": ""
  }
}
```

#### `POST /api/config`

全量保存配置。**注意**：此接口会完整替换配置。如需仅更新选中项，请使用 `POST /api/config/select`。

请求体格式与 `GET /api/config` 响应一致。

响应：`{ "ok": true }`

#### `POST /api/config/select`

定向更新当前选中的 Key 或模型。**推荐使用此接口替代全量保存**，避免双窗口并发写入导致数据丢失。

请求体：

```json
{
  "provider": "stepfun",
  "keyId": "k1",
  "modelId": "step-3.7-flash"
}
```

- `provider` — 必填，厂商标识字符串（如 `"stepfun"`、`"openai"` 等）
- `keyId` — 选填，要设为选中的 Key 的 id
- `modelId` — 选填，要设为选中的模型 ID

响应：`{ "ok": true }`

### 模型查询

#### `POST /api/models/:provider`

从远程 API 拉取模型列表。

请求体：

```json
{
  "key": "sk-xxx",
  "baseUrl": "https://api.stepfun.com/v1"
}
```

- 如果无 API Key，返回空列表
- `baseUrl` 用于访问厂商的 `/v1/models` 接口

响应：

```json
{
  "models": [
    { "id": "step-3.7-flash", "description": "..." },
    { "id": "step-3.5-flash", "description": "..." }
  ]
}
```

### 小组件状态

#### `GET /api/widget`

返回所有厂商当前选中的 Key 和模型信息。

```json
{
  "stepfun": {
    "baseUrl": "https://api.stepfun.com/v1",
    "keyName": "测试号",
    "keyValue": "sk-xxx",
    "selectedModel": "step-3.7-flash"
  }
}
```

## IPC 通信

Electron 主进程与渲染进程之间通过 `contextBridge` 暴露的 API 通信。

### 主窗口 (app-preload.js) — `window.electronApp`

| 方法 | 类型 | 说明 |
|------|------|------|
| `getTheme()` | invoke | 获取当前主题 |
| `setTheme(theme)` | send | 设置主题 |

### 小组件 (widget-preload.js) — `window.electronWidget`

| 方法 | 类型 | 说明 |
|------|------|------|
| `toggle()` | send | 切换小组件显示/隐藏 |
| `setExpanded(bool)` | send | 设置展开状态 |
| `getPosition()` | invoke | 获取保存的位置 |
| `savePosition(x, y)` | send | 保存位置 |
| `resetPosition()` | send | 重置为默认位置 |
| `getLoginItem()` | invoke | 获取开机自启状态 |
| `setLoginItem(bool)` | send | 设置开机自启 |
| `getTheme()` | invoke | 获取主题 |
| `setTheme(theme)` | send | 设置主题 |

## 配置

配置文件 `config.json` 在首次启动时从项目目录自动复制到 `userData` 目录，确保打包后仍可写入。

配置文件以厂商标识为顶层 key，每个厂商的结构如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `{provider}.baseUrl` | string | API 地址 |
| `{provider}.keys[]` | array | API Key 列表 |
| `{provider}.keys[].id` | string | Key 唯一标识 |
| `{provider}.keys[].name` | string | 显示名称 |
| `{provider}.keys[].key` | string | API Key 值 |
| `{provider}.keys[].selected` | boolean | 是否为当前选中 |
| `{provider}.selectedModel` | string | 当前选中的模型 ID |

厂商标识示例：`stepfun`、`opencode`、`openai`、`deepseek`、`custom` 等。

## 主题偏好

主题存储在 widget-state.json 中（userData 目录），主窗口与小组件共享主题配置。

- `"light"` — 浅色主题
- `"dark"` — 深色主题（默认）

## 日志

日志输出到控制台并追加到 `app.log` 文件，包含时间戳和日志等级（INFO / WARN / ERROR / DEBUG）。

## 开发说明

- 使用 `node --check` 验证 JavaScript 语法
- `config.json` 不应包含真实生产环境的 API Key
- `build-dist/`、`dist/`、`node_modules/`、`.electron-userdata/`、`app.log` 不纳入版本管理
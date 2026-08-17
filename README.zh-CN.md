# BYOK for Copilot Chat

**Bring Your Own Key** — 在 VS Code Copilot Chat 中使用任意兼容的 LLM。

支持 OpenAI 兼容协议和 Anthropic Messages 协议，包含 Tool Call（函数调用）、Thinking（推理）、Vision Proxy（视觉代理）等完整能力。

> 本项目参考自 [deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot)，在双协议支持、多端点管理等方面进行了扩展和重构。

## 特点

- 🔑 **BYOK** — 自带 API Key，使用你自己的模型和账户
- 🔌 **双协议** — 同时支持 OpenAI 兼容接口和 Anthropic Messages 接口
- 🛠️ **Tool Call** — 完整支持函数调用，包括流式增量解析
- 🧠 **Thinking/Reasoning** — 支持推理模型的流式 thinking 输出
- 👁️ **Vision Proxy** — 独立的视觉代理系统，为不支持多模态的模型提供图片理解能力
- 📦 **多端点管理** — 通过侧边栏或设置配置多个 API 端点
- 🔄 **Replay 标记** — 启用上下文缓存，节省请求成本
- 📊 **用量统计** — 按模型汇总的长期 token 与缓存统计（总和与均值），支持侧边栏概览与完整统计面板

## 快速开始

### 安装

#### 本地打包安装

```bash
git clone https://github.com/pangdegui/byok-for-copilot.git
cd byok-for-copilot
npm install
npm run compile
npx vsce package --out dist/
```

然后在 VS Code 中执行 **Extensions: Install from VSIX**，选择生成的 `dist/*.vsix` 文件。

#### Marketplace

暂未上架 VS Marketplace，请通过本地打包安装。

### 配置端点

#### 通过侧边栏（推荐）

1. 点击活动栏（Activity Bar）中的 **BYOK** 图标
2. 点击 **Add Endpoint**（+）
3. 填写：
   - **名称** — 自定义标识（如 `my-provider`）
   - **API URL** — API 基础地址
   - **协议** — `openai-completions` 或 `anthropic-messages`
   - **模型** — 逗号分隔的模型 ID 列表
4. 点击端点条目，设置 **API Key**

#### 通过设置

```json
"byok-copilot.endpoints": [
  {
    "name": "my-openai",
    "baseUrl": "https://api.openai.com/v1",
    "protocol": "openai-completions",
    "models": ["gpt-4o", "gpt-4-turbo"]
  },
  {
    "name": "my-anthropic",
    "baseUrl": "https://api.anthropic.com",
    "protocol": "anthropic-messages",
    "models": ["claude-3-5-sonnet-20241022", "claude-3-opus-20240229"]
  }
]
```

### 选择模型

1. 在 Copilot Chat 输入框打开模型选择器
2. 找到 **BYOK** 分类下的模型（格式：`{modelId}@{endpointName}`）
3. 选择模型开始对话

> 💡 如果模型未显示，运行 `Developer: Manage Language Models` 检查 BYOK 模型是否被隐藏。

## 支持的协议

### OpenAI 兼容协议 (`openai-completions`)

支持所有提供 `/chat/completions` 接口的 API 提供商：

- OpenAI（GPT-4o, GPT-4-turbo 等）
- DeepSeek
- 任意兼容的第三方代理或自部署服务

### Anthropic Messages 协议 (`anthropic-messages`)

支持 Anthropic Messages API：

- Claude 3.5 Sonnet / Haiku
- Claude 3 Opus / Sonnet

如果需要自定义 Anthropic API 版本，可在端点配置中设置 `anthropicVersion`。

## 功能详情

### 隐私说明

BYOK 不会向微软上传任何数据。所有 API 请求**只**发往你自己配置的端点，所有用量统计仅保存在 VS Code 本地全局状态中。

每次请求的 token 用量会在本地记录，用于内置统计与 token 计数校准。默认情况下 BYOK 也会把用量数据发送给本地 Copilot Chat 界面，以便在聊天中显示 token 数。若希望用量数据完全保存在本地（聊天界面不显示 token 数），请关闭 `byok-copilot.privacy.reportUsageToChat`。

### Tool Call（函数调用）

两个协议均支持完整的函数调用流程：

| 阶段 | OpenAI 协议 | Anthropic 协议 |
|------|-------------|----------------|
| 工具定义 | `tools[{function}]` | `tools[{input_schema}]` |
| 调用请求 | `tool_calls[]` | `tool_use` content block |
| 结果回传 | `role: tool` | `tool_result` content block |
| 流式解析 | `tool_calls` delta 按 index 累积 | `input_json_delta` 按 index 累积 |

单个请求最多支持 **128 个函数定义**。

### Thinking / Reasoning

支持推理模型的流式 thinking 输出。当模型能力标记 `thinking: true` 时，在请求中加入 `thinking` 参数。用户可在模型选择器中调整推理力度（`high` / `max` / `none`）。

### Vision Proxy（视觉代理）

视觉能力通过独立的代理系统实现，不要求主 LLM 本身支持多模态：

- 图片自动提取 → 发送到视觉代理 → 获取文本描述 → 注入主请求
- 支持三种视觉代理协议：
  - OpenAI Chat Completions（`image_url`）
  - OpenAI Responses（`input_image`）
  - Anthropic Messages（`image` base64）
- 可配置回退到 VS Code 内置的语言模型进行图片描述

视觉代理通过 `BYOK: Configure Vision Proxy` 命令配置。

### 实验性功能

**Stabilize Tool List** — 通过预先激活工具减少工具列表变化对上下文缓存命中率的影响。在设置中开启 `byok-copilot.experimental.stabilizeToolList`。

### 多端点管理

侧边栏支持完整的端点管理操作：

- 添加/删除端点
- 为每个端点独立设置 API Key
- 编辑端点配置
- 为端点添加/删除模型
- 每个端点可独立指定认证方式（`bearer` / `x-api-key`）
- 每个端点可独立指定协议和 API 版本

### 用量统计

BYOK 活动栏中的**用量统计**视图按模型显示简略汇总。点击**打开用量统计**按钮即可打开完整统计面板，其中包含：

- 每个模型的输入/输出/总 token 总和与均值
- 缓存命中、未命中 token 数以及聚合缓存命中率
- 平均 `chars/token` 比值（用于 token 计数校准）
- 刷新、导出（JSON）、**导入（JSON）**、重置单个模型、重置全部数据等控制按钮

**导出 / 导入**：面板可将统计以 JSON 复制到剪贴板（导出），也可从剪贴板读回（导入）。导入接受与导出相同的 JSON 格式，并支持**合并**到现有数据或**替换**全部数据两种方式。

统计数据来自每次请求的 usage 上报，保存在 VS Code 的本地全局状态中，不会上传。token 数为 `NaN`/非法的请求会被跳过，以免污染长期统计数据。

### 模型 ID 覆盖

如果 API 提供商使用不同的模型名称，可通过 `modelIdOverrides` 设置覆盖：

```json
"byok-copilot.modelIdOverrides": {
  "byok-v4-flash": "deepseek-chat",
  "byok-v4-pro": "deepseek-reasoner"
}
```

## 设置项

| 设置项 | 说明 |
|--------|------|
| `byok-copilot.endpoints` | API 端点配置列表 |
| `byok-copilot.maxTokens` | 每次请求的最大输出 Token 数（0 表示不限制） |
| `byok-copilot.modelIdOverrides` | 模型 ID 映射覆盖 |
| `byok-copilot.visionModel` | 视觉代理配置 |
| `byok-copilot.visionPrompt` | 视觉描述提示词 |
| `byok-copilot.experimental.stabilizeToolList` | 启用工具列表预激活 |
| `byok-copilot.debugMode` | 诊断日志级别（minimal / metadata / verbose） |
| `byok-copilot.privacy.reportUsageToChat` | 是否把每次请求的 token 用量发送给本地 Copilot Chat 界面（默认开启） |

## 诊断与调试

- `BYOK: Show Logs` — 查看诊断日志
- `BYOK: Open Request Dumps Folder` — 打开完整请求 Dump 目录（需将 debugMode 设为 verbose）
- `BYOK: Open Settings` — 打开扩展设置

## 开发

### 环境要求

- Node.js >= 24
- VS Code >= 1.116.0

### 构建

```bash
npm install
npm run compile
```

### 打包

```bash
npm run package
```

### 项目结构

```
src/
├── auth.ts               # API Key 管理（SecretStorage）
├── config.ts             # 端点解析与运行时配置
├── consts.ts             # 编译时常量、模型模板
├── types.ts              # 共享类型定义
├── client/               # API 客户端
│   ├── core.ts           #   OpenAI SSE 流式客户端
│   ├── openai/core.ts    #   OpenAI 独立客户端
│   └── anthropic/core.ts #   Anthropic 事件流客户端
├── provider/             # LanguageModelChatProvider 实现
│   ├── index.ts          #   Provider 入口
│   ├── request.ts        #   请求构建（双协议）
│   ├── stream.ts         #   流式响应处理
│   ├── convert.ts        #   消息/工具格式转换
│   ├── tools/            #   工具调用编排
│   │   ├── flow.ts       #     工具流编排
│   │   ├── request.ts    #     工具请求准备
│   │   ├── preflight.ts  #     工具预检激活
│   │   └── notices.ts    #     工具通知
│   └── vision/           #   视觉代理系统
└── runtime/              # 扩展生命周期
```

## 许可

MIT License — 详见 [LICENSE](./LICENSE)。
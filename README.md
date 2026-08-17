# BYOK for Copilot Chat

**Bring Your Own Key** — Use any compatible LLM in VS Code Copilot Chat.

Supports the OpenAI-compatible protocol and the Anthropic Messages protocol, with full Tool Call, Thinking/Reasoning, and Vision Proxy capabilities.

> This project is based on [deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot), extended and refactored with dual-protocol support, multi-endpoint management, and more.

## Features

- 🔑 **BYOK** — Bring your own API key and use your own model and account
- 🔌 **Dual Protocol** — Supports both OpenAI-compatible and Anthropic Messages APIs
- 🛠️ **Tool Call** — Full function calling support, including streaming delta parsing
- 🧠 **Thinking/Reasoning** — Streaming thinking output for reasoning models
- 👁️ **Vision Proxy** — Independent vision proxy system that provides image understanding for models without native multimodal support
- 📦 **Multi-Endpoint Management** — Configure multiple API endpoints via sidebar or settings
- 🔄 **Replay Markers** — Enable context caching to reduce request costs
- 📊 **Usage Statistics** — Per-model long-term token & cache statistics (totals and averages), shown in the sidebar and a full statistics panel

## Quick Start

### Installation

#### Build from Source

```bash
git clone https://github.com/pangdegui/byok-for-copilot.git
cd byok-for-copilot
npm install
npm run compile
npx vsce package --out dist/
```

Then in VS Code, run **Extensions: Install from VSIX** and select the generated `dist/*.vsix` file.

#### Marketplace

Not yet published on the VS Marketplace. Please install locally from source.

### Configure Endpoints

#### Via Sidebar (Recommended)

1. Click the **BYOK** icon in the Activity Bar
2. Click **Add Endpoint** (+)
3. Fill in:
   - **Name** — a friendly identifier (e.g., `my-provider`)
   - **API URL** — the base URL of your API provider
   - **Protocol** — `openai-completions` or `anthropic-messages`
   - **Models** — comma-separated model IDs
4. Click the endpoint entry and set your **API Key**

#### Via Settings

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

### Select a Model

1. Open the model picker in the Copilot Chat input box
2. Find models under the **BYOK** category (format: `{modelId}@{endpointName}`)
3. Select a model and start chatting

> 💡 If models are hidden, run `Developer: Manage Language Models` to check whether BYOK models are visible.

## Supported Protocols

### OpenAI-Compatible (`openai-completions`)

Works with any API provider that offers the `/chat/completions` endpoint:

- OpenAI (GPT-4o, GPT-4-turbo, etc.)
- DeepSeek
- Any compatible third-party proxy or self-hosted service

### Anthropic Messages (`anthropic-messages`)

Works with the Anthropic Messages API:

- Claude 3.5 Sonnet / Haiku
- Claude 3 Opus / Sonnet

You can set a custom `anthropicVersion` in the endpoint configuration if needed.

## Feature Details

### Privacy

BYOK never uploads anything to Microsoft. All API requests go **only** to the endpoints you configure, and all usage statistics are stored locally in VS Code's global state.

Per-request token usage is recorded locally for the built-in statistics and token-count calibration. By default BYOK also sends the usage data to the local Copilot Chat UI so token counts appear in the chat. To keep usage data entirely local (hiding the token counts from the chat UI), disable `byok-copilot.privacy.reportUsageToChat`.

### Tool Call (Function Calling)

Both protocols support the full function calling flow:

| Phase | OpenAI Protocol | Anthropic Protocol |
|-------|----------------|--------------------|
| Tool Definition | `tools[{function}]` | `tools[{input_schema}]` |
| Call Request | `tool_calls[]` | `tool_use` content block |
| Result Return | `role: tool` | `tool_result` content block |
| Stream Parsing | `tool_calls` delta accumulated by index | `input_json_delta` accumulated by index |

Up to **128 function definitions** are supported per request.

### Thinking / Reasoning

Streaming thinking output for reasoning models. When a model's capabilities include `thinking: true`, the `thinking` parameter is added to requests. Users can adjust reasoning effort (`high` / `max` / `none`) in the model picker.

### Vision Proxy

Vision capability is provided through an independent proxy system, without requiring the primary LLM to support multimodal input:

- Images are automatically extracted → sent to a vision proxy → the resulting text description is injected into the main request
- Supports three vision proxy protocols:
  - OpenAI Chat Completions (`image_url`)
  - OpenAI Responses (`input_image`)
  - Anthropic Messages (`image` base64)
- Can fall back to VS Code's built-in language model for image description

Configure the vision proxy via the `BYOK: Configure Vision Proxy` command.

### Experimental Features

**Stabilize Tool List** — Pre-activates tools to reduce the impact of tool list changes on context cache hit rate. Enable via `byok-copilot.experimental.stabilizeToolList` in settings.

### Multi-Endpoint Management

The sidebar supports full endpoint management:

- Add / delete endpoints
- Set a separate API Key for each endpoint
- Edit endpoint configuration
- Add / remove models per endpoint
- Independent authentication method per endpoint (`bearer` / `x-api-key`)
- Independent protocol and API version per endpoint

### Usage Statistics

The **Usage Statistics** view (in the BYOK Activity Bar) shows a compact summary per model. Click the **Open Usage Statistics** button to open the full statistics panel, which includes:

- Per-model totals and averages for input / output / total tokens
- Cache hit & miss token counts and the aggregate cache hit rate
- Average `chars/token` ratio for token-count calibration
- Controls to refresh, export (JSON), reset a single model, or reset all data

Statistics are aggregated from every request's usage report and persisted locally in VS Code's global state — nothing is uploaded. Requests whose token counts are `NaN`/invalid are skipped so they never pollute the long-term numbers.

### Model ID Overrides

If your API provider uses different model names, override them via the `modelIdOverrides` setting:

```json
"byok-copilot.modelIdOverrides": {
  "byok-v4-flash": "deepseek-chat",
  "byok-v4-pro": "deepseek-reasoner"
}
```

## Settings

| Setting | Description |
|---------|-------------|
| `byok-copilot.endpoints` | List of API endpoint configurations |
| `byok-copilot.maxTokens` | Maximum output tokens per request (0 = no limit) |
| `byok-copilot.modelIdOverrides` | Model ID mapping overrides |
| `byok-copilot.visionModel` | Vision proxy configuration |
| `byok-copilot.visionPrompt` | Vision description prompt |
| `byok-copilot.experimental.stabilizeToolList` | Enable tool list pre-activation |
| `byok-copilot.debugMode` | Diagnostic log level (`minimal` / `metadata` / `verbose`) |
| `byok-copilot.privacy.reportUsageToChat` | Report per-request token usage to the local Copilot Chat UI (default `true`) |

## Diagnostics & Debugging

- `BYOK: Show Logs` — View diagnostic logs
- `BYOK: Open Request Dumps Folder` — Open the request dump directory (requires `debugMode` set to `verbose`)
- `BYOK: Open Settings` — Open extension settings

## Development

### Prerequisites

- Node.js >= 24
- VS Code >= 1.116.0

### Build

```bash
npm install
npm run compile
```

### Package

```bash
npx vsce package --out dist/
```

### Project Structure

```
src/
├── auth.ts               # API Key management (SecretStorage)
├── config.ts             # Endpoint resolution & runtime config
├── consts.ts             # Compile-time constants, model templates
├── types.ts              # Shared type definitions
├── client/               # API clients
│   ├── core.ts           #   OpenAI SSE streaming client
│   ├── openai/core.ts    #   OpenAI standalone client
│   └── anthropic/core.ts #   Anthropic event-stream client
├── provider/             # LanguageModelChatProvider implementation
│   ├── index.ts          #   Provider entry point
│   ├── request.ts        #   Request builder (dual protocol)
│   ├── stream.ts         #   Streaming response handling
│   ├── convert.ts        #   Message/tool format conversion
│   ├── tools/            #   Tool calling orchestration
│   │   ├── flow.ts       #     Tool flow orchestration
│   │   ├── request.ts    #     Tool request preparation
│   │   ├── preflight.ts  #     Tool preflight activation
│   │   └── notices.ts    #     Tool notices
│   └── vision/           #   Vision proxy system
└── runtime/              # Extension lifecycle
```

## License

MIT License — see [LICENSE](./LICENSE).

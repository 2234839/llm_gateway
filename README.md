# LLM Gateway

A unified LLM API gateway that aggregates OpenAI, Anthropic, Azure OpenAI and other providers behind a single endpoint. Supports cross-protocol format conversion (Anthropic ↔ OpenAI), intelligent routing, concurrency control, real-time monitoring and request logging.

[**中文文档**](docs/README.zh-CN.md)

## Why

When using multiple LLM providers, you'll run into these problems:

- **Client compatibility**: Claude Code only speaks Anthropic API, Cursor only speaks OpenAI API — you want to freely switch backends without changing client config
- **Protocol isolation**: Route Anthropic-protocol clients to OpenAI models, or vice versa
- **Concurrency management**: Each provider has its own rate limits that need centralized control
- **Observability**: Know which provider handled each request, which model was used, and how long it took
- **Routing policies**: Automatically route to different providers/models based on model name or request content

LLM Gateway solves all of these.

## Features

- **Protocol-agnostic proxy**: Clients send requests in Anthropic or OpenAI format, the gateway auto-converts to the target provider's protocol
- **Bidirectional format conversion**: Anthropic ↔ OpenAI conversion across request body, non-streaming response, and SSE streaming
- **Intelligent routing**: Model name glob matching + message content matching (keyword/regex/multimodal detection), with AND/OR logic composition
- **Concurrency control**: Per-provider max concurrency via Semaphore
- **Real-time monitoring**: SSE event stream + concurrency trend charts + live request log stream
- **Request logging**: SQLite persistence with pagination and content expansion
- **Admin dashboard**: Vue 3 SPA for provider management, route rule configuration, and log viewing

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) >= 1.0

### Install & Run

```bash
# Clone
git clone <repo-url>
cd llm_gateway

# Install dependencies
bun install

# Development mode (backend watch + Vite frontend)
bun run dev

# Or production mode
bun run build:web
bun run start
```

Visit `http://localhost:3827` for the admin dashboard.

### Configure Providers

Add providers in the **Providers** page of the admin dashboard:

| Field | Description |
|-------|-------------|
| Name | Custom identifier |
| Type | `openai` / `anthropic` / `azure-openai` / `custom` |
| API Base URL | Provider API endpoint |
| API Key | Authentication key |
| Models | Supported model names for this provider |
| Max Concurrency | Concurrent request limit (0 = unlimited) |

### Configure Route Rules

Add rules in the **Route Rules** page to define model name matching conditions and target providers. Supports:

- **Model name matching**: glob patterns like `claude-*`, `gpt-4*`
- **Content matching**:
  - Keyword inclusion
  - Regular expressions
  - Multimodal content type detection (image / file / tool_use)
  - Multi-condition AND/OR composition
- **Target model mapping**: Fixed target model name, or source-to-target model name mapping

### Usage

Point your client's API base URL to the gateway:

```bash
# Anthropic protocol clients (e.g. Claude Code)
export ANTHROPIC_BASE_URL=http://localhost:3827/anthropic
export ANTHROPIC_API_KEY=your-key

# OpenAI protocol clients (e.g. Cursor)
export OPENAI_BASE_URL=http://localhost:3827/openai/v1
export OPENAI_API_KEY=your-key
```

The gateway will route requests to the appropriate provider based on route rules, performing protocol conversion when necessary.

## API Endpoints

### Proxy Routes (for LLM clients)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/anthropic/v1/messages` | Anthropic Messages API proxy |
| POST | `/openai/v1/chat/completions` | OpenAI Chat Completions API proxy |
| GET | `/openai/v1/models` | Aggregated model list |
| POST | `/anthropic/v1/messages/count_tokens` | Token count estimation |

### Admin Routes

| Method | Path | Description |
|--------|------|-------------|
| GET/POST/PUT/DELETE | `/admin/providers/*` | Provider CRUD |
| GET/POST/PUT/DELETE | `/admin/routes/*` | Route rule CRUD |
| GET/POST | `/admin/providers/test` | Provider connectivity test |
| GET | `/admin/logs` | Request log query |
| GET | `/admin/stats` | Request statistics |
| GET/PUT | `/admin/config` | Gateway config |
| GET | `/admin/events` | SSE real-time event stream |
| GET | `/health` | Health check |

## Project Structure

```
src/
├── server/
│   ├── index.ts              # Backend entry point
│   ├── types.ts              # TypeScript type definitions
│   ├── db.ts                 # SQLite database layer
│   ├── converters/           # Anthropic ↔ OpenAI format converters (bidirectional)
│   ├── providers/            # Provider adapters + registry
│   ├── routes/               # Routes: proxy + admin + health check
│   └── utils/                # Event bus, semaphore, logging utilities
└── web/
    ├── App.vue               # Root component (navigation + theme toggle)
    ├── api.ts                # Frontend API wrapper
    ├── styles/               # Global styles (dark/light theme)
    └── components/           # Dashboard / ProviderList / RouteRules / RequestLog
```

## Tech Stack

- **Backend**: Bun + Fastify + SQLite (bun:sqlite)
- **Frontend**: Vue 3 + Chart.js + Vanilla CSS
- **Build**: Vite (frontend) + Bun (backend, runs natively)

## License

MIT

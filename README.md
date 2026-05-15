# LLM Gateway

A unified LLM API proxy gateway with **content-aware routing** and **bidirectional protocol conversion** (Anthropic ↔ OpenAI). Built for teams who want fine-grained control over how LLM requests are routed — not just round-robin load balancing, but intelligent routing based on what's actually in the request.

[**中文文档**](docs/README.zh-CN.md)

## Why LLM Gateway

Other gateways do account rotation and billing. LLM Gateway does something different — it understands **what you're asking** and routes accordingly.

**Content-aware routing that no other gateway provides:**
- Route code review to a cheap model, architecture design to a premium model — based on **message content**
- Route image-containing requests to vision-capable models — based on **content type detection**
- Route Claude Code sessions to a dedicated provider — based on **API key group**
- Use Claude Code with OpenAI models, or Cursor with Anthropic models — via **protocol conversion**

When your team has 10 people sharing LLM access, you need to answer:
- Who used what? → Per-key usage tracking
- Can we limit the junior devs? → Per-group token quotas
- Can different roles use different models? → Group-based routing
- Can we use any SDK with any provider? → Bidirectional protocol conversion

## Features

### Routing Engine (The Killer Feature)

- **Model name matching**: glob patterns like `claude-*`, `gpt-4*`
- **Content-aware routing**: keyword inclusion, regex matching, multimodal content type detection
- **Group-based routing**: different API key groups can match different route rules
- **Exclusion rules**: skip certain patterns with negative matching
- **Fallback providers**: automatic failover to backup providers on 5xx/timeout
- **Priority ordering**: rules evaluated top-down, first match wins

### Protocol Conversion

- **Bidirectional**: Anthropic ↔ OpenAI, including request body, non-streaming response, and SSE streaming
- **Transparent**: same-protocol requests pass through with zero overhead (raw byte passthrough)
- **SDK-compatible**: works with any client using standard Anthropic or OpenAI SDKs

### Team Management

- **API Key authentication**: gateway-level keys (not provider keys), compatible with both SDK conventions
- **Key groups**: organize keys by team/role, route rules can target specific groups
- **Token quotas**: daily/monthly per-key or per-group limits, RPM rate limiting (all default to unlimited)
- **Usage tracking**: token usage by provider, model, key, and group

### Observability

- **Real-time dashboard**: concurrency trend charts, live request stream, token usage by hour
- **Request logging**: SQLite persistence with full request/response content (pruned automatically)
- **Per-request details**: model mapping, matched route rule, provider, duration, token counts

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

Visit `http://localhost:3827` for the admin dashboard. On first visit, you'll be guided to set up an admin account.

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
- **Content matching**: keyword inclusion, regex, multimodal content type detection, multi-condition AND/OR
- **Group-based routing**: route different API key groups to different providers
- **Exclusion rules**: negative matching to skip certain patterns
- **Target model mapping**: fixed name or source-to-target mapping

### Create API Keys (Optional)

In the **API Keys** page, create key groups and API keys for your team members. Each key belongs to a group, and you can set per-key or per-group token quotas (default: unlimited).

### Usage

Point your client's API base URL to the gateway:

```bash
# Anthropic protocol clients (e.g. Claude Code)
export ANTHROPIC_BASE_URL=http://localhost:3827
export ANTHROPIC_API_KEY=sk-your-gateway-key

# OpenAI protocol clients (e.g. Cursor)
export OPENAI_BASE_URL=http://localhost:3827/v1
export OPENAI_API_KEY=sk-your-gateway-key
```

When API key auth is disabled (default), any key value works. Enable it in Settings to require valid gateway keys.

## API Endpoints

### Proxy Routes (for LLM clients)

The gateway exposes both protocols at the root path — no prefix needed:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/messages` | Anthropic Messages API proxy |
| POST | `/v1/chat/completions` | OpenAI Chat Completions API proxy |
| GET | `/v1/models` | Aggregated model list (both formats) |
| POST | `/v1/messages/count_tokens` | Token count estimation |

Legacy prefixed paths (`/anthropic/*`, `/openai/*`) are also supported for backward compatibility.

### Admin Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/init-check` | Check if admin is initialized |
| POST | `/admin/init` | Initialize admin account |
| GET/PUT | `/admin/config` | Gateway config & auth settings |
| GET/POST/PUT/DELETE | `/admin/providers/*` | Provider CRUD |
| GET/POST | `/admin/providers/test` | Provider connectivity test |
| GET/POST/PUT/DELETE | `/admin/routes/*` | Route rule CRUD |
| GET/POST/PUT/DELETE | `/admin/key-groups/*` | Key group CRUD |
| GET/POST/PUT/DELETE | `/admin/keys/*` | API key CRUD |
| GET | `/admin/token-stats/by-group` | Token usage by group |
| GET | `/admin/token-stats/by-key` | Token usage by key |
| GET | `/admin/logs` | Request log query (filterable by key/group) |
| GET | `/admin/stats` | Request statistics |
| GET | `/admin/events` | SSE real-time event stream |
| GET | `/health` | Health check |

## Project Structure

```
src/
├── server/
│   ├── index.ts              # Backend entry point
│   ├── types.ts              # TypeScript type definitions
│   ├── config.ts             # Config manager (data/config.json)
│   ├── db.ts                 # SQLite database layer
│   ├── auth.ts               # API key auth + admin Basic Auth hooks
│   ├── quota.ts              # Token quota & RPM rate limiting
│   ├── converters/           # Anthropic ↔ OpenAI format converters (bidirectional)
│   ├── providers/            # Provider adapters + registry
│   ├── routes/               # Routes: proxy + admin + health check
│   └── utils/                # Event bus, semaphore, logging, key generation
└── web/
    ├── App.vue               # Root component (navigation + init flow + settings)
    ├── api.ts                # Frontend API wrapper
    ├── i18n/                 # Internationalization (Chinese / English)
    ├── styles/               # Global styles (dark/light theme)
    └── components/           # Dashboard / ProviderList / RouteRules / ApiKeyList / RequestLog
```

## Tech Stack

- **Backend**: Bun + Fastify + SQLite (bun:sqlite)
- **Frontend**: Vue 3 + Chart.js + Vanilla CSS
- **Build**: Vite (frontend) + Bun (backend, runs natively)
- **Single-binary deploy**: `bun build --compile` embeds frontend assets

## License

MIT

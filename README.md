# LLM Gateway

A self-hosted LLM API gateway. Routes requests to the right model based on **what's in them**, not just the model name. Translates between Anthropic and OpenAI protocols so any tool works with any provider.

[**中文文档**](docs/README.zh-CN.md)

## 30-Second Setup

Download from [Releases](https://github.com/2234839/llm_gateway/releases), run it:

```bash
./llm-gateway
```

Open `http://localhost:3827`. Done.

No Node.js, no Docker, no config files. Single binary, SQLite under the hood, admin dashboard included.

## What Makes This Different

Most LLM gateways rotate API keys and tally bills. This one reads your request content and decides where it should go.

**The routing problem it solves:**

Your team uses Claude Code, Cursor, and a custom app. You have OpenAI, Anthropic, and a cheap local model. Right now every tool is hardcoded to one provider. You want:

- Code review requests → the cheap model (detected by message content)
- Architecture discussions → the premium model (detected by message content)
- Image requests → a vision-capable model (detected by content type)
- Junior devs → limited token quota (by key group)
- Claude Code → can call OpenAI models (protocol conversion)
- Cursor → can call Anthropic models (protocol conversion)

That's content-aware routing with protocol translation. That's what this does.

## Routing Examples

| Rule | Match | Route To |
|------|-------|----------|
| Model pattern | `gpt-4*` | Any provider with matching models |
| Keyword in message | "review this code" | A cost-effective model |
| Content type | Contains images | A vision model |
| API key group | `senior-devs` group | Premium provider with high quota |
| Exclude pattern | Contains "/internal/" | Skip this rule, try next |

Rules are evaluated top-down. First match wins. Each rule can have fallback providers for when the primary fails.

## Feature Breakdown

**Routing**
- Glob model matching (`claude-*`, `gpt-4*`)
- Keyword / regex content matching
- Multimodal content type detection (images, files, tool calls)
- Per-group routing (different teams see different rules)
- Exclusion rules with priority over match rules
- Fallback providers on 5xx / timeout
- Source-to-target model name mapping

**Protocol Conversion**
- Anthropic ↔ OpenAI, bidirectional
- Covers request body, streaming SSE, and non-streaming responses
- Same-protocol requests pass through as raw bytes — zero conversion overhead
- Works with official SDKs, no client changes needed

**Team Management**
- Gateway-level API keys (not your provider keys)
- Key groups with per-group and per-key token quotas (daily / monthly)
- RPM rate limiting
- Usage tracking by provider, model, key, and group

**Dashboard**
- Real-time concurrency monitoring with trend charts
- Live request stream via SSE
- Token usage breakdown by hour, provider, model
- Full request/response logging (auto-pruned)

## Quick Start

### From Source

Requires [Bun](https://bun.sh/) >= 1.0.

```bash
git clone <repo-url>
cd llm_gateway
bun install
bun run dev        # dev mode: backend watch + Vite frontend
```

Or build for production:

```bash
bun run build      # builds frontend + single binary
./llm-gateway
```

### Point Your Tools At It

```bash
# Claude Code, or any Anthropic SDK client
export ANTHROPIC_BASE_URL=http://localhost:3827/anthropic
export ANTHROPIC_API_KEY=sk-your-gateway-key

# Cursor, or any OpenAI SDK client
export OPENAI_BASE_URL=http://localhost:3827/openai/v1
export OPENAI_API_KEY=sk-your-gateway-key
```

By default, auth is off — any key works. Enable it in Settings to require valid gateway keys.

## API

### Proxy Endpoints

No protocol-specific prefixes needed — the gateway detects the format:

| Method | Path | Protocol |
|--------|------|----------|
| POST | `/v1/messages` | Anthropic Messages API |
| POST | `/v1/chat/completions` | OpenAI Chat Completions API |
| GET | `/v1/models` | Aggregated model list |
| POST | `/v1/messages/count_tokens` | Token count estimation |

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/init-check` | Check if admin is set up |
| POST | `/admin/init` | Create admin account |
| GET/PUT | `/admin/config` | Gateway settings |
| CRUD | `/admin/providers/*` | Provider management |
| GET/POST | `/admin/providers/test` | Connectivity test |
| CRUD | `/admin/routes/*` | Route rule management |
| CRUD | `/admin/key-groups/*` | Key group management |
| CRUD | `/admin/keys/*` | API key management |
| GET | `/admin/token-stats/by-group` | Usage by group |
| GET | `/admin/token-stats/by-key` | Usage by key |
| GET | `/admin/logs` | Request logs |
| GET | `/admin/stats` | Request statistics |
| GET | `/admin/events` | SSE event stream |
| GET | `/health` | Health check |

## Tech Stack

Bun runtime + Fastify + bun:sqlite + Vue 3 + Chart.js. Single-binary deployment via `bun build --compile`.

## License

MIT

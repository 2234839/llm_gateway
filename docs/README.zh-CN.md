# LLM Gateway

自托管 LLM API 网关。根据**请求内容**智能路由，而不只是看模型名。自动翻译 Anthropic 和 OpenAI 协议，让任何工具都能对接任何服务商。

[**English Documentation**](../README.md)

## 30 秒启动

从 [Releases](https://github.com/2234839/llm_gateway/releases) 下载，运行：

```bash
./llm-gateway
```

打开 `http://localhost:3827`，开始用。

不需要 Node.js、不需要 Docker、不需要配置文件。单文件可执行，底层 SQLite，自带管理后台。

**数据存储**：所有数据（数据库、配置）存储在可执行文件旁边的 `data/` 目录中，首次运行时自动创建。

## 跟其他网关有什么不同

大多数 LLM 网关做账号轮转和计费。这个网关会读你的请求内容，然后决定路由到哪里。

**它解决的路由问题：**

你的团队用 Claude Code、Cursor、还有自己写的应用。手头有 OpenAI、Anthropic、和一个便宜的本地模型。现在每个工具都写死了一个服务商。你想要：

- 包含图片的请求 → 视觉模型（根据内容类型自动识别）
- 代码审查请求 → 便宜模型（根据消息内容自动识别）
- 架构设计讨论 → 高端模型（根据消息内容自动识别）
- 初级开发者 → 限制 Token 配额（按 Key 分组控制）
- Claude Code → 能调用 OpenAI 模型（协议转换）
- Cursor → 能调用 Anthropic 模型（协议转换）

这就是内容感知路由 + 协议翻译。就是这东西做的事。

## 路由示例

| 规则 | 匹配方式 | 路由到 |
|------|----------|--------|
| 模型名 | `gpt-4*` | 任何有匹配模型的服务商 |
| 消息关键词 | "review this code" | 经济模型 |
| 内容类型 | 包含图片 | 视觉模型 |
| Key 分组 | `senior-devs` 分组 | 高端服务商，高配额 |
| 排除规则 | 包含 "/internal/" | 跳过此规则，继续匹配下一条 |

规则从上到下依次评估，首个匹配生效。每条规则可配置备选服务商，主服务商失败时自动切换。

## 功能

**路由**
- Glob 模型名匹配（`claude-*`、`gpt-4*`）
- 关键词 / 正则内容匹配
- 多模态内容类型检测（图片、文件、工具调用）
- 按分组路由（不同团队看到不同规则）
- 排除规则，优先级高于匹配规则
- 主服务商 5xx / 超时时自动故障转移
- 源模型名 → 目标模型名映射

**协议转换**
- Anthropic ↔ OpenAI，双向
- 覆盖请求体、SSE 流式响应、非流式响应
- 同协议请求直接透传原始字节，零转换开销
- 兼容官方 SDK，客户端无需改动
- 兼容 OpenAI 兼容服务商，包括 **Kimi（Moonshot）**、**DeepSeek**、**GLM（智谱）**

**团队管理**
- 网关级 API Key（不是你的服务商密钥）
- Key 分组，支持按分组和按 Key 的 Token 配额（每日 / 每月）
- RPM 速率限制
- 按服务商、模型、Key、分组的用量统计

**仪表盘**
- 实时并发监控和趋势图
- 实时请求流（SSE 推送）
- 按小时、服务商、模型的 Token 用量
- 完整请求/响应日志（自动裁剪）

## 快速开始

### 从源码构建

需要 [Bun](https://bun.sh/) >= 1.0。

```bash
git clone <repo-url>
cd llm_gateway
bun install
bun run dev        # 开发模式：后端 watch + Vite 前端
```

生产构建：

```bash
bun run build      # 构建前端 + 生成单文件可执行
./llm-gateway
```

### 把你的工具指过来

```bash
# Claude Code，或任何 Anthropic SDK 客户端
export ANTHROPIC_BASE_URL=http://localhost:3827/anthropic
export ANTHROPIC_API_KEY=sk-your-gateway-key

# Cursor，或任何 OpenAI SDK 客户端
export OPENAI_BASE_URL=http://localhost:3827/openai/v1
export OPENAI_API_KEY=sk-your-gateway-key
```

默认关闭认证，任意 Key 值均可使用。在设置中开启后需使用有效的网关密钥。

## API

### 代理端点

无需指定协议前缀——网关自动识别请求格式：

| 方法 | 路径 | 协议 |
|------|------|------|
| POST | `/v1/messages` | Anthropic Messages API |
| POST | `/v1/chat/completions` | OpenAI Chat Completions API |
| GET | `/v1/models` | 聚合模型列表 |
| POST | `/v1/messages/count_tokens` | Token 计数估算 |

### 管理端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/init-check` | 检查管理员是否已设置 |
| POST | `/admin/init` | 创建管理员帐号 |
| GET/PUT | `/admin/config` | 网关设置 |
| CRUD | `/admin/providers/*` | 服务商管理 |
| GET/POST | `/admin/providers/test` | 连通性测试 |
| CRUD | `/admin/routes/*` | 路由规则管理 |
| CRUD | `/admin/key-groups/*` | Key 分组管理 |
| CRUD | `/admin/keys/*` | API Key 管理 |
| GET | `/admin/token-stats/by-group` | 按分组用量 |
| GET | `/admin/token-stats/by-key` | 按 Key 用量 |
| GET | `/admin/logs` | 请求日志 |
| GET | `/admin/stats` | 请求统计 |
| GET | `/admin/events` | SSE 事件流 |
| GET | `/health` | 健康检查 |

## 技术栈

Bun + Fastify + bun:sqlite + Vue 3 + Chart.js。通过 `bun build --compile` 实现单文件部署。

## License

MIT

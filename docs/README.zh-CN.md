# LLM Gateway

统一的 LLM API 网关，将 OpenAI、Anthropic、Azure OpenAI 等多个 LLM 服务商聚合到一个入口，支持跨协议格式转换（Anthropic ↔ OpenAI），提供智能路由、并发控制、实时监控和请求日志。

## 为什么需要它

当你同时使用多个 LLM 服务商时，会遇到这些问题：

- **客户端兼容性**：Claude Code 只认 Anthropic API，Cursor 只认 OpenAI API，你希望后端自由切换服务商而不改客户端配置
- **协议隔离**：想让 Anthropic 协议的客户端使用 OpenAI 的模型，或反过来
- **并发管理**：每个服务商有独立的并发限制（如 Anthropic 的 rate limit），需要集中管控
- **可观测性**：想知道每个请求走了哪个服务商、用了什么模型、花了多长时间
- **路由策略**：根据模型名或请求内容，自动路由到不同服务商和模型

LLM Gateway 解决所有这些问题。

## 核心特性

- **协议无关代理**：客户端用 Anthropic 或 OpenAI 格式发请求，网关自动转换到目标服务商的协议
- **双向格式转换**：请求体、非流式响应、SSE 流三个维度的 Anthropic ↔ OpenAI 互转
- **智能路由**：按模型名 glob 匹配 + 按消息内容匹配（关键词/正则/多模态检测），支持 AND/OR 逻辑组合
- **并发控制**：每个服务商独立设置最大并发，基于 Semaphore 实现
- **实时监控**：SSE 事件流 + 并发趋势图表 + 请求实时日志流
- **请求日志**：SQLite 持久化，支持分页查询和内容展开查看
- **管理后台**：Vue 3 单页应用，服务商管理、路由规则配置、日志查看一体化

## 快速开始

### 前置条件

- [Bun](https://bun.sh/) >= 1.0

### 安装与运行

```bash
# 克隆项目
git clone <repo-url>
cd llm_gateway

# 安装依赖
bun install

# 开发模式（后端 watch + Vite 前端）
bun run dev

# 或生产模式
bun run build:web
bun run start
```

启动后访问 `http://localhost:3827` 进入管理后台。

### 配置服务商

在管理后台的「服务商」页面添加服务商，填写：

| 字段 | 说明 |
|------|------|
| 名称 | 自定义标识 |
| 类型 | `openai` / `anthropic` / `azure-openai` / `custom` |
| 接口地址 | 服务商 API Base URL |
| API Key | 认证密钥 |
| 模型列表 | 该服务商支持的模型名称 |
| 最大并发 | 并发请求数上限（0 = 不限制） |

### 配置路由规则

在「路由规则」页面添加规则，定义模型名匹配条件和目标服务商。支持：

- **模型名匹配**：glob 模式，如 `claude-*`、`gpt-4*`
- **内容匹配**：
  - 关键词包含
  - 正则表达式
  - 多模态内容类型检测（image / file / tool_use）
  - 多条件 AND/OR 组合
- **目标模型映射**：固定目标模型名，或按源模型名映射

### 使用

配置好后，将客户端的 API 地址指向网关即可：

```bash
# Anthropic 协议客户端（如 Claude Code）
export ANTHROPIC_BASE_URL=http://localhost:3827/anthropic
export ANTHROPIC_API_KEY=your-key

# OpenAI 协议客户端（如 Cursor）
export OPENAI_BASE_URL=http://localhost:3827/openai/v1
export OPENAI_API_KEY=your-key
```

网关会根据路由规则自动转发到对应的服务商，并在必要时进行协议格式转换。

## API 端点

### 代理路由（面向 LLM 客户端）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/anthropic/v1/messages` | Anthropic Messages API 代理 |
| POST | `/openai/v1/chat/completions` | OpenAI Chat Completions API 代理 |
| GET | `/openai/v1/models` | 聚合模型列表 |
| POST | `/anthropic/v1/messages/count_tokens` | Token 计数估算 |

### 管理路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/admin/providers/*` | 服务商 CRUD |
| GET/POST/PUT/DELETE | `/admin/routes/*` | 路由规则 CRUD |
| GET/POST | `/admin/providers/test` | 服务商连通性测试 |
| GET | `/admin/logs` | 请求日志查询 |
| GET | `/admin/stats` | 请求统计 |
| GET/PUT | `/admin/config` | 网关配置 |
| GET | `/admin/events` | SSE 实时事件流 |
| GET | `/health` | 健康检查 |

## 项目结构

```
src/
├── server/
│   ├── index.ts              # 后端入口
│   ├── types.ts              # TypeScript 类型定义
│   ├── db.ts                 # SQLite 数据库层
│   ├── converters/           # Anthropic ↔ OpenAI 格式转换器（双向 6 个）
│   ├── providers/            # 服务商适配器 + 注册中心
│   ├── routes/               # 路由：代理 + 管理 + 健康检查
│   └── utils/                # 事件总线、信号量、日志工具
└── web/
    ├── App.vue               # 根组件（导航 + 主题切换）
    ├── api.ts                # 前端 API 封装
    ├── styles/               # 全局样式（暗色/亮色主题）
    └── components/           # Dashboard / ProviderList / RouteRules / RequestLog
```

## 技术栈

- **后端**：Bun + Fastify + SQLite（bun:sqlite）
- **前端**：Vue 3 + Chart.js + 原生 CSS
- **构建**：Vite（前端）+ Bun（后端原生运行）

## License

MIT

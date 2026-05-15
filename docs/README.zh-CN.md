# LLM Gateway

统一的 LLM API 代理网关，核心能力是**内容感知路由**和**双向协议转换**（Anthropic ↔ OpenAI）。为需要精细化控制 LLM 请求路由的团队而建——不是简单的轮询负载均衡，而是基于请求内容的智能路由。

[**English Documentation**](../README.md)

## 为什么选择 LLM Gateway

其他网关做账号轮转和计费。LLM Gateway 做的事情不同——它理解**你在问什么**，并据此路由。

**独一无二的内容感知路由：**
- 根据消息内容，将代码审查路由到廉价模型，架构设计路由到高端模型
- 根据内容类型检测，将包含图片的请求路由到视觉模型
- 根据 API Key 分组，将 Claude Code 会话路由到指定服务商
- 通过协议转换，用 Claude Code 调用 OpenAI 模型，或用 Cursor 调用 Anthropic 模型

当你的团队有 10 个人共享 LLM 访问时，你需要回答：
- 谁用了什么？→ 按 Key 用量追踪
- 能限制初级开发者吗？→ 按分组 Token 配额
- 不同角色能用不同模型吗？→ 基于分组的路由
- 任何 SDK 都能连任何服务商吗？→ 双向协议转换

## 特性

### 路由引擎（杀手级特性）

- **模型名匹配**：glob 模式，如 `claude-*`、`gpt-4*`
- **内容感知路由**：关键词包含、正则匹配、多模态内容类型检测
- **分组路由**：不同 API Key 分组匹配不同的路由规则
- **排除规则**：负匹配跳过特定模式
- **故障转移**：主 Provider 失败（5xx / 超时）时自动尝试备选 Provider
- **优先级排序**：规则自上而下评估，首个匹配生效

### 协议转换

- **双向**：Anthropic ↔ OpenAI，包括请求体、非流式响应和 SSE 流式
- **零开销透传**：同协议请求直接透传原始字节
- **SDK 兼容**：任何使用标准 Anthropic 或 OpenAI SDK 的客户端均可使用

### 团队管理

- **API Key 认证**：网关级密钥（非服务商密钥），兼容两种 SDK 约定
- **密钥分组**：按团队/角色组织密钥，路由规则可针对特定分组
- **Token 配额**：按 Key 或按分组的每日/每月限额、RPM 速率限制（均默认不限）
- **用量追踪**：按服务商、模型、密钥、分组的 Token 用量统计

### 可观测性

- **实时仪表盘**：并发趋势图、实时请求流、按小时 Token 用量
- **请求日志**：SQLite 持久化，包含完整请求/响应内容（自动裁剪）
- **单请求详情**：模型映射、命中路由规则、服务商、耗时、Token 计数

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

启动后访问 `http://localhost:3827` 进入管理后台。首次访问时会引导设置管理员帐号。

### 配置服务商

在管理后台的「服务商」页面添加服务商：

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
- **内容匹配**：关键词包含、正则匹配、多模态内容类型检测、多条件 AND/OR 组合
- **分组路由**：不同 API Key 分组路由到不同服务商
- **排除规则**：负匹配跳过特定模式
- **目标模型映射**：固定目标模型名，或按源模型名映射

### 创建 API Key（可选）

在「API Key」页面创建密钥分组和 API Key。每个 Key 属于一个分组，可设置按 Key 或按分组的 Token 配额（默认：不限）。

### 使用

将客户端的 API 地址指向网关：

```bash
# Anthropic 协议客户端（如 Claude Code）
export ANTHROPIC_BASE_URL=http://localhost:3827
export ANTHROPIC_API_KEY=sk-your-gateway-key

# OpenAI 协议客户端（如 Cursor）
export OPENAI_BASE_URL=http://localhost:3827/v1
export OPENAI_API_KEY=sk-your-gateway-key
```

API Key 认证默认关闭，任意 Key 值均可使用。在设置中开启后，需使用有效的网关密钥。

## API 端点

### 代理路由（面向 LLM 客户端）

网关在根路径同时暴露两种协议，无需指定前缀：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/messages` | Anthropic Messages API 代理 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions API 代理 |
| GET | `/v1/models` | 聚合模型列表（两种格式） |
| POST | `/v1/messages/count_tokens` | Token 计数估算 |

旧版前缀路径（`/anthropic/*`、`/openai/*`）仍可使用，向后兼容。

### 管理路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/admin/init-check` | 检查管理员是否已初始化 |
| POST | `/admin/init` | 初始化管理员帐号 |
| GET/PUT | `/admin/config` | 网关配置与认证设置 |
| GET/POST/PUT/DELETE | `/admin/providers/*` | 服务商 CRUD |
| GET/POST | `/admin/providers/test` | 服务商连通性测试 |
| GET/POST/PUT/DELETE | `/admin/routes/*` | 路由规则 CRUD |
| GET/POST/PUT/DELETE | `/admin/key-groups/*` | 密钥分组 CRUD |
| GET/POST/PUT/DELETE | `/admin/keys/*` | API Key CRUD |
| GET | `/admin/token-stats/by-group` | 按分组 Token 用量 |
| GET | `/admin/token-stats/by-key` | 按 Key Token 用量 |
| GET | `/admin/logs` | 请求日志查询（支持按 Key/分组过滤） |
| GET | `/admin/stats` | 请求统计 |
| GET | `/admin/events` | SSE 实时事件流 |
| GET | `/health` | 健康检查 |

## 项目结构

```
src/
├── server/
│   ├── index.ts              # 后端入口
│   ├── types.ts              # TypeScript 类型定义
│   ├── config.ts             # 配置管理器 (data/config.json)
│   ├── db.ts                 # SQLite 数据库层
│   ├── auth.ts               # API Key 认证 + 管理员 Basic Auth 钩子
│   ├── quota.ts              # Token 配额与 RPM 速率限制
│   ├── converters/           # Anthropic ↔ OpenAI 格式转换器（双向）
│   ├── providers/            # 服务商适配器 + 注册中心
│   ├── routes/               # 路由：代理 + 管理 + 健康检查
│   └── utils/                # 事件总线、信号量、日志工具、密钥生成
└── web/
    ├── App.vue               # 根组件（导航 + 初始化引导 + 设置）
    ├── api.ts                # 前端 API 封装
    ├── i18n/                 # 国际化（中文 / 英文）
    ├── styles/               # 全局样式（暗色/亮色主题）
    └── components/           # Dashboard / ProviderList / RouteRules / ApiKeyList / RequestLog
```

## 技术栈

- **后端**：Bun + Fastify + SQLite（bun:sqlite）
- **前端**：Vue 3 + Chart.js + 原生 CSS
- **构建**：Vite（前端）+ Bun（后端原生运行）
- **单文件部署**：`bun build --compile` 嵌入前端资源

## License

MIT

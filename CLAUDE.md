# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

LLM Gateway — 统一 LLM API 代理网关。核心能力是双向协议转换：客户端使用 Anthropic Messages API 可路由到 OpenAI 模型，反之亦然，网关自动翻译请求/响应格式（包括 SSE 流式）。

**技术栈**: Bun runtime + Fastify + bun:sqlite + Vue 3 + Chart.js + Vite

## Common Commands

```bash
bun run dev              # 同时启动后端(watch) + 前端(vite dev server)
bun run dev:server       # 仅后端 watch 模式
bun run dev:web          # 仅前端 Vite dev server (端口 5173, 代理 API 到 3827)
bun run typecheck        # 服务端类型检查
bun run typecheck:web    # 前端类型检查
bun run build            # 完整构建: 前端 → embed-assets.ts → 单文件可执行
bun run build:web        # 仅前端 Vite 构建
```

无 linter、无测试框架、无 formatter。

## Architecture

### 请求流转

```
Client → Fastify Route → ProviderRegistry.resolve(model, context)
       → Provider (Anthropic/OpenAI/Azure/Custom)
       → [协议转换] → 上游 API → [响应转换] → Client
```

路由解析通过 SQLite 中的 route_rules 表，按优先级降序匹配：glob 模式匹配模型名 → 内容匹配(keyword/regex/content_type) → 确定 provider + targetModel。

### 核心模块

- **`src/server/index.ts`** — 入口，Fastify 初始化，静态文件服务(生产用嵌入资源，开发用 @fastify/static)
- **`src/server/types.ts`** — 所有 TypeScript 类型定义（Anthropic/OpenAI 请求响应、配置、DB）
- **`src/server/db.ts`** — SQLite 数据库层(GatewayDB)，WAL 模式，prepared statement 缓存，4 表：config/providers/route_rules/request_logs
- **`src/server/providers/registry.ts`** — 路由解析 + 并发信号量控制
- **`src/server/providers/openai.ts`** / **`anthropic.ts`** — Provider 适配器
- **`src/server/converters/`** — 双向协议转换（请求体转换 + 非流式响应转换 + SSE 流式转换）
- **`src/server/routes/anthropic.ts`** / **`openai.ts`** — API 路由，提取 token 用量，写日志，发事件
- **`src/server/sse.ts`** — SSE 解析/格式化工具函数
- **`src/server/utils/event-bus.ts`** — 进程内发布订阅，桥接请求处理与 SSE 推送

### 前端

Vue 3 SPA，无 vue-router（tab 切换用 v-if），无状态管理库。i18n 中英双语。Dashboard 通过 SSE 接收实时事件（并发历史 + 请求生命周期）。

### 关键设计决策

- **单文件部署**: 前端通过 Bun `import with { type: "file" }` 嵌入编译产物，`bun build --compile` 生成单二进制
- **流式直通 vs 转换**: 同协议用 `streamPassthrough` 管道原始字节（同时解析提取日志信息）；跨协议用完整转换状态机
- **日志内容裁剪**: `pruneLogContent()` 保留元数据但清空超出保留数(默认1000)的 input/output_content
- **无认证层**: 网关本身不鉴权，预期运行在可信网络

## GitHub Actions Release

发布流程定义在 `.github/workflows/release.yml`：

**触发条件**: 推送 `v*` 格式的 tag（如 `v0.2.0`）

**发布步骤**:
```bash
# 1. 创建 tag 并推送，自动触发构建
git tag v0.2.0
git push origin v0.2.0

# 2. CI 自动执行:
#    - 5 平台矩阵构建 (linux-x64/arm64, windows-x64, macos-x64/arm64)
#    - 每个平台: bun install → bun run scripts/build.ts <target>
#    - 使用 softprops/action-gh-release 创建 GitHub Release 并上传所有产物
```

**发布后必须跟踪 CI 构建状态直到完成**:
1. 推送 tag 后，使用 GitHub API 查询构建进度：
   - 查看 runs: `curl -s "https://api.github.com/repos/2234839/llm_gateway/actions/runs?per_page=1"`
   - 轮询状态直到 `status` 为 `completed`，检查 `conclusion` 为 `success`
2. 确认 Release 已创建且包含所有平台产物: `curl -s "https://api.github.com/repos/2234839/llm_gateway/releases/tags/<tag>"`
3. 如果构建失败，查看失败日志: `gh run view <run_id> --log-failed`，排查问题后修复并重新推送 tag

**build.ts 接受的 target 参数**: `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`, `bun-darwin-x64`, `bun-darwin-arm64`

本地构建指定平台: `bun run scripts/build.ts bun-linux-x64`

## 文档规范

- **多语言同步**: 项目文档包含英文版 `README.md` 和中文版 `docs/README.zh-CN.md`。更新任一文档时，**必须同步更新另一语言版本**，保持内容一致。
- **i18n 同步**: 前端国际化文件 `src/web/i18n/zh.ts` 和 `src/web/i18n/en.ts` 也必须同步维护，新增键时两文件都要添加。

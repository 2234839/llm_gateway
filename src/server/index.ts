import Fastify from "fastify"
import cors from "@fastify/cors"
import { existsSync } from "node:fs"
import { extname } from "node:path"
import { GatewayDB } from "./db.ts"
import { ProviderRegistry } from "./providers/registry.ts"
import { anthropicRoutes } from "./routes/anthropic.ts"
import { openaiRoutes } from "./routes/openai.ts"
import { adminRoutes } from "./routes/admin.ts"
import { healthRoutes } from "./routes/health.ts"
import { embeddedAssets } from "./embed-assets.ts"
import { ConfigManager } from "./config.ts"
import { StatsCache } from "./utils/stats-cache.ts"
import { createApiAuthHook, createAdminAuthHook } from "./auth.ts"

/** ANSI 颜色 */
const C = {
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
}

/** 可读日志流：将 pino JSON 转为人类可读格式 */
const prettyStream = {
  write(msg: string) {
    try {
      const obj = JSON.parse(msg)
      const time = new Date(obj.time).toLocaleTimeString("zh-CN", { hour12: false })
      const levelMap: Record<number, [string, string]> = {
        20: ["DBG ", C.dim],
        30: ["INFO", C.green],
        40: ["WARN", C.yellow],
        50: ["ERR ", C.red],
        60: ["FTL ", C.red + C.bold],
      }
      const [level, levelColor] = levelMap[obj.level] ?? ["????", ""]
      const parts: string[] = []

      if (obj.req) {
        parts.push(`${C.cyan}${obj.req.method}${C.reset} ${obj.url ?? ""}`)
      }
      if (obj.res) {
        const s = obj.res.statusCode
        parts.push(`${s >= 400 ? C.red : s >= 300 ? C.yellow : C.green}${s}${C.reset}`)
      }
      if (obj.responseTime != null) {
        const ms = Math.round(obj.responseTime)
        parts.push(`${ms > 1000 ? C.red : ms > 200 ? C.yellow : C.dim}${ms}ms${C.reset}`)
      }
      if (obj.msg) parts.push(obj.msg)

      console.log(`${C.dim}${time}${C.reset} ${levelColor}${level}${C.reset} ${parts.join(" ")}`)
    } catch {
      console.log(msg.trimEnd())
    }
  },
}

declare module "fastify" {
  interface FastifyInstance {
    db: GatewayDB
    registry: ProviderRegistry
    configManager: ConfigManager
    statsCache: StatsCache
    closeSSEConnections: () => void
  }
  interface FastifyRequest {
    authContext: import("./types.ts").AuthContext | null
  }
}

async function main() {
  const db = new GatewayDB("data/gateway.db")
  const configManager = new ConfigManager()
  /** 服务器启动时间戳（秒），用于 /v1/models 的 created 字段 */
  const startedAt = Math.floor(Date.now() / 1000)
  const config = db.getConfig()

  const fastify = Fastify({
    logger: { stream: prettyStream, level: config.logLevel } as Record<string, unknown>,
    bodyLimit: 50 * 1024 * 1024,
    /** SIGINT 时强制关闭所有连接（包括 keep-alive），不等待 */
    forceCloseConnections: true,
  })

  fastify.decorate("db", db)
  fastify.decorate("registry", new ProviderRegistry(db))
  fastify.decorate("configManager", configManager)
  fastify.decorate("statsCache", new StatsCache(db))

  await fastify.register(cors, { origin: true })

  /** 全局错误处理器：捕获未处理的异常，返回统一格式 */
  fastify.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number; validation?: unknown }
    /** Fastify 验证错误（如 body 解析失败） */
    if (err.validation) {
      reply.status(400).send({ error: { message: err.message, type: "invalid_request_error" } })
      return
    }
    /** 不要泄露内部错误详情 */
    const status = err.statusCode ?? 500
    fastify.log.error(error)
    reply.status(status).send({
      error: {
        message: status >= 500 ? "Internal server error" : err.message,
        type: status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error",
      },
    })
  })

  /** Admin 认证钩子 */
  fastify.addHook("onRequest", createAdminAuthHook(configManager))

  /** API 路由带认证 */
  const apiAuthHook = createApiAuthHook(db, configManager)
  await fastify.register(async (instance) => {
    instance.addHook("onRequest", apiAuthHook)
    instance.register(anthropicRoutes)
  }, { prefix: "/anthropic" })
  await fastify.register(async (instance) => {
    instance.addHook("onRequest", apiAuthHook)
    instance.register(openaiRoutes)
  }, { prefix: "/openai" })

  /** 自动协议路由 — 根路径同时暴露两种 API，客户端无需指定前缀 */
  await fastify.register(async (instance) => {
    instance.addHook("onRequest", apiAuthHook)
    instance.register(anthropicRoutes)
    instance.register(openaiRoutes)

    /** GET /v1/models — 统一模型发现，同时兼容 OpenAI 和 Anthropic 响应格式 */
    instance.get("/v1/models", async (request, reply) => {
      const auth = request.authContext
      const models = fastify.registry.getAvailableModels(auth?.groupId)
      const data = models.map(m => ({
        id: m.id,
        object: "model",
        created: startedAt,
        owned_by: m.owned_by,
      }))
      return reply.send({
        object: "list",
        data,
        has_more: false,
      })
    })
  })

  await fastify.register(adminRoutes)
  await fastify.register(healthRoutes)

  /** MIME 类型推断 */
  const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  }

  function getContentType(path: string): string {
    const ext = extname(path)
    return MIME_TYPES[ext] ?? "application/octet-stream"
  }

  /** 静态文件服务 */
  const hasEmbeddedAssets = Object.keys(embeddedAssets).length > 0
  if (hasEmbeddedAssets) {
    /** 生产模式：从编译嵌入的资源中提供服务 */
    for (const [urlPath, filePath] of Object.entries(embeddedAssets)) {
      if (urlPath === "/") continue
      fastify.get(urlPath, async (_req, reply) => {
        const content = await Bun.file(filePath).bytes()
        /** 带 hash 的静态资源（如 /assets/index-xxx.js）可永久缓存 */
        reply.header("Cache-Control", urlPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache")
        return reply.type(getContentType(urlPath)).send(content)
      })
    }

    fastify.setNotFoundHandler(async (_req, reply) => {
      const indexPath = embeddedAssets["/"]
      if (indexPath) {
        const content = await Bun.file(indexPath).bytes()
        return reply.type("text/html").send(content)
      }
      return reply.status(404).send({ error: "Not found" })
    })
  } else {
    /** 开发模式：从文件系统读取（如果 dist/web 存在） */
    const staticDir = new URL("../../dist/web", import.meta.url).pathname
    if (existsSync(staticDir)) {
      const staticModule = await import("@fastify/static")
      await fastify.register(staticModule.default, {
        root: staticDir,
        prefix: "/",
        wildcard: false,
      })

      fastify.setNotFoundHandler(async (_request, reply) => {
        return reply.status(200).send(await Bun.file(`${staticDir}/index.html`).text())
      })
    }
  }

  const port = parseInt(process.env.PORT ?? "") || config.port || 3827
  try {
    await fastify.listen({ port, host: "0.0.0.0" })
    console.log(`LLM Gateway running on http://localhost:${port}`)
    if (configManager.isAdminInitialized()) {
      console.log(`  Admin panel: protected (username: ${configManager.get().admin!.username})`)
    } else {
      console.log("  Admin panel: open (no admin account configured)")
    }
    if (configManager.get().authRequired) {
      console.log("  API auth: required")
    } else {
      console.log("  API auth: optional (requests without key are allowed)")
    }
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }

  /** 优雅关闭：确保 SQLite WAL 正确 checkpoint */
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\nReceived ${signal}, shutting down gracefully...`)
    /** 10 秒超时强制退出，避免 close 钩子挂起 */
    const forceTimer = setTimeout(() => {
      console.error("Graceful shutdown timed out, forcing exit")
      process.exit(1)
    }, 10_000)
    try {
      /** 先关闭 SSE 长连接（管理面板），避免阻塞 fastify.close() */
      fastify.closeSSEConnections?.()
      await fastify.close()
      db.close()
      console.log("Goodbye.")
    } catch (err) {
      console.error("Error during shutdown:", err)
    }
    clearTimeout(forceTimer)
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch(err => { console.error("Fatal:", err); process.exit(1) })

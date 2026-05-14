import Fastify from "fastify"
import cors from "@fastify/cors"
import { existsSync } from "node:fs"
import { GatewayDB } from "./db.ts"
import { ProviderRegistry } from "./providers/registry.ts"
import { anthropicRoutes } from "./routes/anthropic.ts"
import { openaiRoutes } from "./routes/openai.ts"
import { adminRoutes } from "./routes/admin.ts"
import { healthRoutes } from "./routes/health.ts"

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
  }
}

async function main() {
  const db = new GatewayDB("data/gateway.db")
  const config = db.getConfig()

  const fastify = Fastify({
    logger: { stream: prettyStream, level: config.logLevel } as Record<string, unknown>,
    bodyLimit: 50 * 1024 * 1024,
  })

  fastify.decorate("db", db)
  fastify.decorate("registry", new ProviderRegistry(db))

  await fastify.register(cors, { origin: true })

  await fastify.register(anthropicRoutes)
  await fastify.register(openaiRoutes)
  await fastify.register(adminRoutes)
  await fastify.register(healthRoutes)

  /** 静态文件服务（前端产物，仅生产模式） */
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

  const port = parseInt(process.env.PORT ?? "") || config.port || 3827
  try {
    await fastify.listen({ port, host: "0.0.0.0" })
    console.log(`LLM Gateway running on http://localhost:${port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

main()

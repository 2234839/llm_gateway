import type { FastifyInstance } from "fastify"

/** 构建时注入的版本号（scripts/build.ts --define）；dev 模式（bun run）无注入，回落到 process.env.GATEWAY_VERSION（scripts/dev.ts 设置为 x.y.z-dev） */
const VERSION: string = typeof __GATEWAY_VERSION__ !== "undefined" ? __GATEWAY_VERSION__ : (process.env.GATEWAY_VERSION ?? "dev")

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async () => {
    try {
      /** 从 registry 内存缓存获取 provider/rule 数据，避免 DB 查询 */
      const providers = fastify.registry.getProviderConfigs()
      const enabled = providers.filter(p => p.enabled).length
      const rules = fastify.registry.getRuleCount()
      const config = fastify.db.getConfig()
      const stats = fastify.statsCache.getHealthData()

      return {
        status: "ok",
        version: VERSION,
        uptime: process.uptime(),
        port: config.port,
        providers: { total: providers.length, enabled },
        routeRules: rules,
        requests: stats.logStats,
        requestsByProvider: stats.byProvider,
        requestsByModel: stats.byModel,
        tokenStats: stats.tokenStats,
        tokensByProvider: stats.tokensByProvider,
        tokensByModel: stats.tokensByModel,
      }
    } catch (err) {
      /** health 端点自身不应崩溃，返回降级响应 */
      return {
        status: "degraded",
        version: VERSION,
        uptime: process.uptime(),
        error: (err as Error).message,
      }
    }
  })
}

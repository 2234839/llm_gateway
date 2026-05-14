import type { FastifyInstance } from "fastify"

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async () => {
    const providers = fastify.db.getProviders()
    const enabled = providers.filter(p => p.enabled).length
    const rules = fastify.db.getRouteRules().length
    const stats = fastify.db.getLogStats()
    const config = fastify.db.getConfig()

    return {
      status: "ok",
      uptime: process.uptime(),
      port: config.port,
      providers: { total: providers.length, enabled },
      routeRules: rules,
      requests: stats,
      requestsByProvider: fastify.db.getLogStatsByProvider(),
      requestsByModel: fastify.db.getLogStatsByModel(),
    }
  })
}

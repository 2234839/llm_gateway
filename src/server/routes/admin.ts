import type { FastifyInstance } from "fastify"
import type { ProviderConfig, RouteRule } from "../types.ts"
import { v4 as uuid } from "uuid"
import { emitEvent, onEvent, type BusEvent } from "../utils/event-bus.ts"

export async function adminRoutes(fastify: FastifyInstance) {
  // ========== Providers ==========

  fastify.get("/admin/providers", async () => {
    return fastify.db.getProviders()
  })

  fastify.post<{ Body: Omit<ProviderConfig, "id"> }>("/admin/providers", async (request, reply) => {
    const body = request.body
    const provider: ProviderConfig = {
      ...body,
      id: uuid(),
    }
    fastify.db.addProvider(provider)
    fastify.registry.reload()
    return reply.status(201).send(provider)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<ProviderConfig> }>("/admin/providers/:id", async (request, reply) => {
    const { id } = request.params
    const existing = fastify.db.getProvider(id)
    if (!existing) {
      return reply.status(404).send({ error: "Provider not found" })
    }
    fastify.db.updateProvider(id, request.body)
    fastify.registry.reload()
    return reply.send({ ...existing, ...request.body, id })
  })

  fastify.delete<{ Params: { id: string } }>("/admin/providers/:id", async (request, reply) => {
    const { id } = request.params
    fastify.db.deleteProvider(id)
    fastify.registry.reload()
    return reply.status(204).send()
  })

  // ========== Provider Test ==========

  fastify.post<{ Body: { baseUrl: string; apiKey: string; type: string; customHeaders?: Record<string, string> } }>("/admin/providers/test", async (request) => {
    const { baseUrl, apiKey, type, customHeaders } = request.body
    const url = baseUrl.replace(/\/+$/, "")
    const start = performance.now()

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(customHeaders ?? {}),
    }

    let testUrl: string
    let method = "GET"

    if (type === "anthropic") {
      testUrl = `${url}/v1/messages`
      headers["x-api-key"] = apiKey
      headers["anthropic-version"] = "2023-06-01"
      method = "POST"
    } else if (type === "azure-openai") {
      testUrl = `${url}/openai/deployments?api-version=2024-02-01`
      headers["api-key"] = apiKey
    } else {
      testUrl = `${url}/models`
      headers["Authorization"] = `Bearer ${apiKey}`
    }

    const body = type === "anthropic"
      ? JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
      : undefined

    const resp = await fetch(testUrl, { method, headers, body, signal: AbortSignal.timeout(10000) })
    const duration = Math.round(performance.now() - start)

    if (resp.ok) {
      return { success: true, statusCode: resp.status, duration }
    }

    const errorBody = await resp.text().catch(() => "")
    return { success: false, statusCode: resp.status, duration, error: errorBody.slice(0, 500) }
  })

  // ========== Route Rules ==========

  fastify.get("/admin/routes", async () => {
    return fastify.db.getRouteRules()
  })

  fastify.post<{ Body: Omit<RouteRule, "id"> }>("/admin/routes", async (request, reply) => {
    const body = request.body
    const rule: RouteRule = {
      ...body,
      id: uuid(),
    }
    fastify.db.addRouteRule(rule)
    return reply.status(201).send(rule)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<RouteRule> }>("/admin/routes/:id", async (request, reply) => {
    const { id } = request.params
    fastify.db.updateRouteRule(id, request.body)
    return reply.send({ id, ...request.body })
  })

  fastify.delete<{ Params: { id: string } }>("/admin/routes/:id", async (request, reply) => {
    const { id } = request.params
    fastify.db.deleteRouteRule(id)
    return reply.status(204).send()
  })

  // ========== Logs ==========

  fastify.get<{ Querystring: { limit?: string; offset?: string; model?: string; providerId?: string } }>("/admin/logs", async (request) => {
    const { limit, offset, model, providerId } = request.query
    return fastify.db.getLogs({
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
      model: model ?? undefined,
      providerId: providerId ?? undefined,
    })
  })

  fastify.get("/admin/stats", async () => {
    return fastify.db.getLogStats()
  })

  // ========== Token 统计 ==========

  fastify.get("/admin/token-stats", async () => {
    return {
      summary: fastify.db.getTokenStats(),
      byProvider: fastify.db.getTokenStatsByProvider(),
      byModel: fastify.db.getTokenStatsByModel(),
    }
  })

  fastify.get<{ Querystring: { hours?: string } }>("/admin/token-stats/hourly", async (request) => {
    const hours = parseInt(request.query.hours ?? "24")
    return fastify.db.getTokenStatsByHour(hours)
  })

  // ========== Config ==========

  fastify.get("/admin/config", async () => {
    return fastify.db.getConfig()
  })

  fastify.put<{ Body: { port?: number; logLevel?: "debug" | "info" | "warn" | "error"; enableRequestLog?: boolean } }>("/admin/config", async (request) => {
    const current = fastify.db.getConfig()
    const updated = { ...current, ...request.body }
    fastify.db.saveConfig(updated)
    return updated
  })

  // ========== SSE 实时事件流 ==========

  /** 活跃请求追踪：requestId -> { providerId, providerName, model, targetModel } */
  const activeRequests = new Map<string, { providerId: string; providerName: string; model: string; targetModel: string }>()

  /** 并发历史环形缓冲区：并发变化时记录快照，最多保留 300 个 */
  interface ConcurrencySnapshot {
    /** 时间标签 HH:MM:SS */
    time: string
    /** 各 provider 当前并发数 */
    providers: { id: string; current: number }[]
  }
  const maxSnapshots = 300
  const concurrencySnapshots: ConcurrencySnapshot[] = []

  /** 从 activeRequests 统计每个 provider 的实际活跃请求数 */
  function countActiveByProvider(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const [, req] of activeRequests) {
      counts.set(req.providerId, (counts.get(req.providerId) ?? 0) + 1)
    }
    return counts
  }

  /** 记录当前并发快照到环形缓冲区 */
  function recordSnapshot() {
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
    const providers = fastify.registry.getConcurrencyStatus()
    const activeCounts = countActiveByProvider()
    concurrencySnapshots.push({
      time,
      providers: providers.map(p => ({ id: p.id, name: p.name, current: activeCounts.get(p.id) ?? p.current })),
    })
    if (concurrencySnapshots.length > maxSnapshots) concurrencySnapshots.shift()
  }

  /** 聚合并发状态：按 provider 聚合，包含模型维度 */
  function buildConcurrencyPayload() {
    const providerStatus = fastify.registry.getConcurrencyStatus()
    const activeCounts = countActiveByProvider()
    const modelMap = new Map<string, Map<string, { model: string; targetModel: string; count: number }>>()
    for (const [, req] of activeRequests) {
      if (!modelMap.has(req.providerId)) modelMap.set(req.providerId, new Map())
      const models = modelMap.get(req.providerId)!
      const key = `${req.model}->${req.targetModel}`
      const existing = models.get(key)
      if (existing) {
        existing.count++
      } else {
        models.set(key, { model: req.model, targetModel: req.targetModel, count: 1 })
      }
    }
    return providerStatus.map(p => ({
      ...p,
      current: activeCounts.get(p.id) ?? p.current,
      models: [...(modelMap.get(p.id)?.values() ?? [])],
    }))
  }

  /** 事件监听：维护活跃请求表，并发变化时记录快照 */
  onEvent((event: BusEvent) => {
    if (event.type === "request_start") {
      /** 从路由规则反查 providerId */
      const providers = fastify.db.getProviders()
      const provider = providers.find(p => p.name === event.provider)
      activeRequests.set(event.requestId, {
        providerId: provider?.id ?? "",
        providerName: event.provider,
        model: event.model,
        targetModel: event.targetModel,
      })
      recordSnapshot()
    } else if (event.type === "request_end") {
      activeRequests.delete(event.requestId)
      recordSnapshot()
      /** 请求结束后推送最新统计数据 */
      const requests = fastify.db.getLogStats()
      emitEvent({
        type: "request_stats",
        requests,
        byProvider: fastify.db.getLogStatsByProvider(),
        byModel: fastify.db.getLogStatsByModel(),
        tokenStats: fastify.db.getTokenStats(),
      })
    }
  })

  fastify.get("/admin/events", async (request, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    raw.write("data: {\"type\":\"connected\"}\n\n")

    /** 推送历史并发快照，前端刷新后可恢复图表 */
    if (concurrencySnapshots.length > 0) {
      raw.write(`data: ${JSON.stringify({ type: "concurrency_history", snapshots: concurrencySnapshots })}\n\n`)
    }

    /** 推送当前并发状态 */
    const enriched = buildConcurrencyPayload()
    raw.write(`data: ${JSON.stringify({ type: "concurrency", providers: enriched })}\n\n`)

    /** 并发状态定时推送（每 2 秒） */
    const timer = setInterval(() => {
      const enriched = buildConcurrencyPayload()
      raw.write(`data: ${JSON.stringify({ type: "concurrency", providers: enriched })}\n\n`)
    }, 2000)

    /** 监听请求事件并转发 */
    const unsubscribe = onEvent((event: BusEvent) => {
      raw.write(`data: ${JSON.stringify(event)}\n\n`)
    })

    /** 客户端断开时清理 */
    request.raw.on("close", () => {
      clearInterval(timer)
      unsubscribe()
    })
  })
}

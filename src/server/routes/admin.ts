import type { FastifyInstance } from "fastify"
import type { KeyGroup, ApiKey, ApiKeyWithSecret, ProviderConfig, RouteRule } from "../types.ts"
import { v4 as uuid } from "uuid"
import { emitEvent, onEvent, type BusEvent } from "../utils/event-bus.ts"
import { generateApiKey } from "../utils/api-key-gen.ts"
import { createSession, destroySession, extractSessionToken } from "../auth.ts"

/** 设置 session cookie */
function setSessionCookie(reply: import("fastify").FastifyReply, token: string) {
  reply.header("Set-Cookie", `admin_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`)
}

/** 清除 session cookie */
function clearSessionCookie(reply: import("fastify").FastifyReply) {
  reply.header("Set-Cookie", "admin_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}

export async function adminRoutes(fastify: FastifyInstance) {
  // ========== Init & Config ==========

  /** 检查管理员是否已初始化 */
  fastify.get("/admin/init-check", async () => {
    return { initialized: fastify.configManager.isAdminInitialized() }
  })

  /** 初始化管理员帐号，成功后自动创建 session */
  fastify.post<{ Body: { username: string; password: string } }>("/admin/init", async (request, reply) => {
    if (fastify.configManager.isAdminInitialized()) {
      return reply.status(400).send({ error: "Admin already initialized" })
    }
    const { username, password } = request.body
    if (!username || !password || password.length < 4) {
      return reply.status(400).send({ error: "Username and password (min 4 chars) required" })
    }
    await fastify.configManager.initAdmin(username, password)
    /** 初始化成功，直接创建 session 登录 */
    const token = createSession(username)
    setSessionCookie(reply, token)
    return { success: true }
  })

  /** 管理员登录 */
  fastify.post<{ Body: { username: string; password: string } }>("/admin/login", async (request, reply) => {
    const { username, password } = request.body
    if (!username || !password) {
      return reply.status(400).send({ error: "Username and password are required" })
    }
    const valid = await fastify.configManager.verifyAdmin(username, password)
    if (!valid) {
      return reply.status(401).send({ error: "Invalid credentials" })
    }
    const token = createSession(username)
    setSessionCookie(reply, token)
    return { success: true }
  })

  /** 管理员登出 */
  fastify.post("/admin/logout", async (request, reply) => {
    const token = extractSessionToken(request.headers)
    if (token) destroySession(token)
    clearSessionCookie(reply)
    return { success: true }
  })

  /** 获取网关配置 */
  fastify.get("/admin/config", async () => {
    const config = fastify.configManager.get()
    return {
      authRequired: config.authRequired,
      adminInitialized: !!config.admin?.username,
      adminUsername: config.admin?.username ?? null,
    }
  })

  /** 更新网关配置 */
  fastify.put<{ Body: { authRequired?: boolean; newPassword?: string } }>("/admin/config", async (request, reply) => {
    const { authRequired, newPassword } = request.body
    if (authRequired !== undefined) {
      fastify.configManager.setAuthRequired(authRequired)
    }
    if (newPassword) {
      if (newPassword.length < 4) {
        return reply.status(400).send({ error: "Password must be at least 4 characters" })
      }
      await fastify.configManager.changePassword(newPassword)
    }
    return { success: true }
  })

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

  // ========== Key Groups ==========

  fastify.get("/admin/key-groups", async () => {
    const groups = fastify.db.getKeyGroups()
    return groups.map(g => ({
      ...g,
      keyCount: fastify.db.getKeyCountByGroup(g.id),
    }))
  })

  fastify.post<{ Body: Omit<KeyGroup, "id" | "createdAt"> }>("/admin/key-groups", async (request, reply) => {
    const body = request.body
    const group: KeyGroup = {
      ...body,
      id: uuid(),
      createdAt: new Date().toISOString(),
    }
    fastify.db.addKeyGroup(group)
    return reply.status(201).send(group)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<KeyGroup> }>("/admin/key-groups/:id", async (request, reply) => {
    const { id } = request.params
    const existing = fastify.db.getKeyGroup(id)
    if (!existing) {
      return reply.status(404).send({ error: "Key group not found" })
    }
    fastify.db.updateKeyGroup(id, request.body)
    return fastify.db.getKeyGroup(id)
  })

  fastify.delete<{ Params: { id: string } }>("/admin/key-groups/:id", async (request, reply) => {
    const { id } = request.params
    const keyCount = fastify.db.getKeyCountByGroup(id)
    if (keyCount > 0) {
      return reply.status(400).send({ error: `Cannot delete: group has ${keyCount} API keys` })
    }
    fastify.db.deleteKeyGroup(id)
    return { success: true }
  })

  // ========== API Keys ==========

  fastify.get("/admin/keys", async () => {
    return fastify.db.getApiKeys()
  })

  fastify.post<{ Body: { name: string; groupId: string; dailyTokenLimit?: number; monthlyTokenLimit?: number; rpmLimit?: number; description?: string } }>("/admin/keys", async (request, reply) => {
    const body = request.body
    if (!body.name || !body.groupId) {
      return reply.status(400).send({ error: "name and groupId are required" })
    }
    const group = fastify.db.getKeyGroup(body.groupId)
    if (!group) {
      return reply.status(400).send({ error: "Key group not found" })
    }
    const { rawKey, hash, prefix } = generateApiKey()
    const key: ApiKey = {
      id: uuid(),
      name: body.name,
      keyHash: hash,
      keyPrefix: prefix,
      groupId: body.groupId,
      enabled: true,
      dailyTokenLimit: body.dailyTokenLimit ?? 0,
      monthlyTokenLimit: body.monthlyTokenLimit ?? 0,
      rpmLimit: body.rpmLimit ?? 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      description: body.description ?? "",
    }
    fastify.db.addApiKey(key)
    /** 返回时包含原始密钥（仅此一次） */
    const result: ApiKeyWithSecret = { ...key, rawKey }
    return reply.status(201).send(result)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<ApiKey> }>("/admin/keys/:id", async (request, reply) => {
    const { id } = request.params
    const existing = fastify.db.getApiKey(id)
    if (!existing) {
      return reply.status(404).send({ error: "API key not found" })
    }
    /** 不允许通过 update 修改 keyHash 和 keyPrefix */
    const update = { ...request.body }
    delete (update as any).keyHash
    delete (update as any).keyPrefix
    fastify.db.updateApiKey(id, update)
    return fastify.db.getApiKey(id)
  })

  fastify.delete<{ Params: { id: string } }>("/admin/keys/:id", async (request, reply) => {
    fastify.db.deleteApiKey(request.params.id)
    return { success: true }
  })

  // ========== Logs ==========

  fastify.get<{ Querystring: { limit?: string; offset?: string; model?: string; providerId?: string; apiKeyId?: string; groupId?: string } }>("/admin/logs", async (request) => {
    const { limit, offset, model, providerId, apiKeyId, groupId } = request.query
    return fastify.db.getLogs({
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
      model: model ?? undefined,
      providerId: providerId ?? undefined,
      apiKeyId: apiKeyId ?? undefined,
      groupId: groupId ?? undefined,
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

  /** 按密钥分组统计 Token */
  fastify.get("/admin/token-stats/by-group", async () => {
    return fastify.db.getTokenStatsByGroup()
  })

  /** 按密钥统计 Token */
  fastify.get("/admin/token-stats/by-key", async () => {
    return fastify.db.getTokenStatsByKey()
  })

  // ========== SSE 实时事件流 ==========

  /** 活跃请求追踪：requestId -> { providerId, providerName, model, targetModel } */
  const activeRequests = new Map<string, { providerId: string; providerName: string; model: string; targetModel: string }>()

  /** 上游 API 调用追踪：requestId -> providerId */
  const upstreamRequests = new Map<string, string>()

  /** 并发历史环形缓冲区：并发变化时记录快照，最多保留 300 个 */
  interface ConcurrencySnapshot {
    /** 时间标签 HH:MM:SS */
    time: string
    /** 各 provider 两层并发数 */
    providers: { id: string; gateway: number; upstream: number }[]
  }
  const maxSnapshots = 300
  const concurrencySnapshots: ConcurrencySnapshot[] = []

  /** 从 activeRequests 统计每个 provider 的网关层并发数 */
  function countActiveByProvider(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const [, req] of activeRequests) {
      counts.set(req.providerId, (counts.get(req.providerId) ?? 0) + 1)
    }
    return counts
  }

  /** 从 upstreamRequests 统计每个 provider 的上游并发数 */
  function countUpstreamByProvider(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const [, providerId] of upstreamRequests) {
      counts.set(providerId, (counts.get(providerId) ?? 0) + 1)
    }
    return counts
  }

  /** 记录当前并发快照到环形缓冲区 */
  function recordSnapshot() {
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
    const providers = fastify.registry.getConcurrencyStatus()
    const gatewayCounts = countActiveByProvider()
    const upstreamCounts = countUpstreamByProvider()
    concurrencySnapshots.push({
      time,
      providers: providers.map(p => ({
        id: p.id,
        name: p.name,
        gateway: gatewayCounts.get(p.id) ?? 0,
        upstream: upstreamCounts.get(p.id) ?? 0,
      })),
    })
    if (concurrencySnapshots.length > maxSnapshots) concurrencySnapshots.shift()
  }

  /** 聚合并发状态：按 provider 聚合，包含模型维度和两层并发 */
  function buildConcurrencyPayload() {
    const providerStatus = fastify.registry.getConcurrencyStatus()
    const gatewayCounts = countActiveByProvider()
    const upstreamCounts = countUpstreamByProvider()
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
      id: p.id,
      name: p.name,
      max: p.max,
      gateway: gatewayCounts.get(p.id) ?? 0,
      upstream: upstreamCounts.get(p.id) ?? 0,
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
    } else if (event.type === "upstream_start") {
      upstreamRequests.set(event.requestId, event.providerId)
      recordSnapshot()
    } else if (event.type === "upstream_end") {
      upstreamRequests.delete(event.requestId)
      recordSnapshot()
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

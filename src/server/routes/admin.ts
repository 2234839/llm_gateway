import type { FastifyInstance } from "fastify"
import type { KeyGroup, ApiKey, ProviderConfig, RouteRule } from "../types.ts"
import { v4 as uuid } from "uuid"
import { emitEvent, onEvent, onSerializedEvent, type BusEvent } from "../utils/event-bus.ts"
import { generateApiKey } from "../utils/api-key-gen.ts"
import { detectProvider, getProviderDisplayName } from "../utils/provider-detector.ts"
import { queryProviderBalance, queryZhipuQuota, queryWithCurl, parseCurl } from "../utils/balance-query.ts"
import { createSession, destroySession, destroyAllSessions, extractSessionToken, invalidateKeyCache, invalidateAllKeyCache } from "../auth.ts"

/** 设置 session cookie（根据请求协议决定 Secure 标志，HTTP 环境下浏览器会拒绝 Secure cookie） */
function setSessionCookie(reply: import("fastify").FastifyReply, token: string) {
  const secure = reply.request?.protocol === "https" ? "; Secure" : ""
  reply.header("Set-Cookie", `admin_token=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${7 * 24 * 60 * 60}`)
}

/** 清除 session cookie */
function clearSessionCookie(reply: import("fastify").FastifyReply) {
  const secure = reply.request?.protocol === "https" ? "; Secure" : ""
  reply.header("Set-Cookie", `admin_token=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`)
}

/** 登录速率限制：每个 IP 最多 5 次失败 / 15 分钟窗口 */
const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const LOGIN_MAX_ATTEMPTS = 5
const LOGIN_WINDOW_MS = 15 * 60 * 1000

/** Provider 测试限流：每个 IP 最多 10 次 / 60 秒窗口 */
const testAttempts = new Map<string, { count: number; resetAt: number }>()
const TEST_MAX_ATTEMPTS = 10
const TEST_WINDOW_MS = 60_000

function checkTestRate(ip: string): boolean {
  const now = Date.now()
  if (Math.random() < 0.01 || testAttempts.size > 500) {
    for (const [key, val] of testAttempts) {
      if (val.resetAt < now) testAttempts.delete(key)
    }
  }
  const entry = testAttempts.get(ip)
  if (!entry || entry.resetAt < now) {
    testAttempts.set(ip, { count: 1, resetAt: now + TEST_WINDOW_MS })
    return true
  }
  if (entry.count >= TEST_MAX_ATTEMPTS) return false
  entry.count++
  return true
}

function checkLoginRate(ip: string): boolean {
  const now = Date.now()
  /** 惰性清理过期条目：1% 概率或 Map 超过 1000 条时触发 */
  if (Math.random() < 0.01 || loginAttempts.size > 1000) {
    for (const [key, val] of loginAttempts) {
      if (val.resetAt < now) loginAttempts.delete(key)
    }
  }
  const entry = loginAttempts.get(ip)
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS })
    return true
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) return false
  entry.count++
  return true
}

export async function adminRoutes(fastify: FastifyInstance) {

  /** 名称映射缓存：避免每次 /admin/logs 请求都做 3 次 DB 全表扫描 */
  let nameCache: { providerMap: Map<string, string>; keyMap: Map<string, string>; groupMap: Map<string, string> } | null = null

  function getNameMaps() {
    if (!nameCache) {
      nameCache = {
        providerMap: new Map(fastify.db.getProviders().map(p => [p.id, p.name])),
        keyMap: new Map(fastify.db.getApiKeys().map(k => [k.id, k.name])),
        groupMap: new Map(fastify.db.getKeyGroups().map(g => [g.id, g.name])),
      }
    }
    return nameCache
  }

  function invalidateNameCache() {
    nameCache = null
  }

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
    if (!username || !password) {
      return reply.status(400).send({ error: "Username and password required" })
    }
    await fastify.configManager.initAdmin(username, password)
    /** 初始化成功，直接创建 session 登录 */
    const token = createSession(username)
    setSessionCookie(reply, token)
    return { success: true }
  })

  /** 管理员登录 */
  fastify.post<{ Body: { username: string; password: string } }>("/admin/login", async (request, reply) => {
    const ip = request.ip
    if (!checkLoginRate(ip)) {
      return reply.status(429).send({ error: "Too many login attempts. Try again later." })
    }
    const { username, password } = request.body
    if (!username || !password) {
      return reply.status(400).send({ error: "Username and password are required" })
    }
    const valid = await fastify.configManager.verifyAdmin(username, password)
    if (!valid) {
      return reply.status(401).send({ error: "Invalid credentials" })
    }
    /** 登录成功，清除该 IP 的失败计数 */
    loginAttempts.delete(ip)
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
    const gatewayConfig = fastify.db.getConfig()
    return {
      authRequired: config.authRequired,
      adminInitialized: !!config.admin?.username,
      adminUsername: config.admin?.username ?? null,
      cors: gatewayConfig.cors ?? null,
    }
  })

  /** 更新网关配置 */
  fastify.put<{ Body: { authRequired?: boolean; newPassword?: string; gateway?: Partial<import("../types.ts").GatewayConfig> } }>("/admin/config", async (request, reply) => {
    const { authRequired, newPassword, gateway } = request.body
    if (authRequired !== undefined) {
      if (typeof authRequired !== "boolean") return reply.status(400).send({ error: "authRequired must be a boolean" })
      fastify.configManager.setAuthRequired(authRequired)
      /** 同步 authRequired 到 DB，保持双重配置源一致 */
      const dbConfig = fastify.db.getConfig()
      fastify.db.saveConfig({ ...dbConfig, authRequired })
    }
    if (gateway) {
      /** 白名单校验：只允许已知的 GatewayConfig 字段 */
      const allowedKeys = new Set(["port", "logLevel", "enableRequestLog", "logContentRetention", "maxLogRows", "authRequired", "cors"])
      const unknownKeys = Object.keys(gateway).filter(k => !allowedKeys.has(k))
      if (unknownKeys.length > 0) return reply.status(400).send({ error: `Unknown gateway config fields: ${unknownKeys.join(", ")}` })
      if (gateway.port !== undefined && (typeof gateway.port !== "number" || gateway.port < 1 || gateway.port > 65535)) return reply.status(400).send({ error: "port must be 1-65535" })
      if (gateway.logLevel !== undefined && !["debug", "info", "warn", "error"].includes(gateway.logLevel)) return reply.status(400).send({ error: "logLevel must be debug|info|warn|error" })
      if (gateway.enableRequestLog !== undefined && typeof gateway.enableRequestLog !== "boolean") return reply.status(400).send({ error: "enableRequestLog must be a boolean" })
      if (gateway.logContentRetention !== undefined && (typeof gateway.logContentRetention !== "number" || gateway.logContentRetention < 0)) return reply.status(400).send({ error: "logContentRetention must be a non-negative number" })
      if (gateway.maxLogRows !== undefined && (typeof gateway.maxLogRows !== "number" || gateway.maxLogRows < 1000)) return reply.status(400).send({ error: "maxLogRows must be >= 1000" })
      /** CORS 配置验证 */
      if (gateway.cors !== undefined) {
        const c = gateway.cors
        if (typeof c !== "object" || c === null) return reply.status(400).send({ error: "cors must be an object" })
        if (c.origin !== undefined) {
          if (c.origin !== true && !Array.isArray(c.origin)) return reply.status(400).send({ error: "cors.origin must be true or an array of strings" })
          if (Array.isArray(c.origin) && c.origin.some(o => typeof o !== "string")) return reply.status(400).send({ error: "cors.origin must contain only strings" })
        }
        if (c.methods !== undefined) {
          if (!Array.isArray(c.methods) || c.methods.some(m => typeof m !== "string")) return reply.status(400).send({ error: "cors.methods must be an array of strings" })
        }
        if (c.allowedHeaders !== undefined) {
          if (!Array.isArray(c.allowedHeaders) || c.allowedHeaders.some(h => typeof h !== "string")) return reply.status(400).send({ error: "cors.allowedHeaders must be an array of strings" })
        }
      }
      fastify.configManager.updateGateway(gateway)
      /** 同步 gateway 配置到 DB */
      const dbConfig = fastify.db.getConfig()
      fastify.db.saveConfig({ ...dbConfig, ...gateway })
      /** 更新运行时 CORS 配置 */
      if (gateway.cors) {
        fastify.runtimeCors.config = fastify.db.getConfig().cors!
      }
    }
    if (newPassword) {
      await fastify.configManager.changePassword(newPassword)
      /** 修改密码后销毁所有现有 session，强制重新登录 */
      destroyAllSessions()
    }
    return { success: true }
  })

  // ========== Providers ==========

  fastify.get("/admin/providers", async () => {
    return fastify.db.getProviders()
  })

  fastify.post<{ Body: Omit<ProviderConfig, "id"> }>("/admin/providers", async (request, reply) => {
    const body = request.body
    if (!body.name) return reply.status(400).send({ error: "name is required" })
    if (!body.baseUrl) return reply.status(400).send({ error: "baseUrl is required" })
    if (!body.apiKey) return reply.status(400).send({ error: "apiKey is required" })
    if (!body.type) return reply.status(400).send({ error: "type is required" })
    const validTypes = ["openai", "anthropic", "azure-openai", "custom"]
    if (!validTypes.includes(body.type)) return reply.status(400).send({ error: `type must be one of: ${validTypes.join(", ")}` })
    if (!Array.isArray(body.models) || body.models.length === 0) return reply.status(400).send({ error: "models must be a non-empty array" })
    if (body.models.some((m: unknown) => typeof m !== "string" || !m.trim())) return reply.status(400).send({ error: "Each model must be a non-empty string" })
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") return reply.status(400).send({ error: "enabled must be a boolean" })
    if (body.maxConcurrency !== undefined && (typeof body.maxConcurrency !== "number" || body.maxConcurrency < 0)) return reply.status(400).send({ error: "maxConcurrency must be a non-negative number" })
    if (body.requestTimeout !== undefined && (typeof body.requestTimeout !== "number" || body.requestTimeout < 0)) return reply.status(400).send({ error: "requestTimeout must be a non-negative number" })
    const provider: ProviderConfig = {
      ...body,
      id: uuid(),
    }
    fastify.db.addProvider(provider)
    fastify.registry.reload()
    invalidateNameCache()
    return reply.status(201).send(provider)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<ProviderConfig> }>("/admin/providers/:id", async (request, reply) => {
    const { id } = request.params
    const existing = fastify.db.getProvider(id)
    if (!existing) {
      return reply.status(404).send({ error: "Provider not found" })
    }
    const update = { ...request.body }
    if (update.type) {
      const validTypes = ["openai", "anthropic", "azure-openai", "custom"]
      if (!validTypes.includes(update.type)) return reply.status(400).send({ error: `type must be one of: ${validTypes.join(", ")}` })
    }
    if (update.models !== undefined && (!Array.isArray(update.models) || update.models.length === 0)) {
      return reply.status(400).send({ error: "models must be a non-empty array" })
    }
    if (Array.isArray(update.models) && update.models.some((m: unknown) => typeof m !== "string" || !m.trim())) {
      return reply.status(400).send({ error: "Each model must be a non-empty string" })
    }
    if (update.enabled !== undefined && typeof update.enabled !== "boolean") return reply.status(400).send({ error: "enabled must be a boolean" })
    if (update.maxConcurrency !== undefined && (typeof update.maxConcurrency !== "number" || update.maxConcurrency < 0)) return reply.status(400).send({ error: "maxConcurrency must be a non-negative number" })
    if (update.requestTimeout !== undefined && (typeof update.requestTimeout !== "number" || update.requestTimeout < 0)) return reply.status(400).send({ error: "requestTimeout must be a non-negative number" })
    fastify.db.updateProvider(id, update)
    fastify.registry.reload()
    invalidateNameCache()
    return fastify.db.getProvider(id)
  })

  fastify.delete<{ Params: { id: string } }>("/admin/providers/:id", async (request, reply) => {
    const { id } = request.params
    /** 检查是否有关联的路由规则 */
    const rules = fastify.db.getRouteRules()
    const affectedRules = rules.filter(r => r.providerId === id || r.fallbacks?.some(fb => fb.providerId === id))
    if (affectedRules.length > 0) {
      const names = affectedRules.map(r => r.pattern || r.id).join(", ")
      return reply.status(400).send({ error: `Cannot delete: route rules [${names}] reference this provider. Remove or update those rules first.` })
    }
    fastify.db.deleteProvider(id)
    fastify.registry.reload()
    invalidateNameCache()
    return reply.status(204).send()
  })

  // ========== Provider Test ==========

  /** 检查 URL 是否为安全的公网地址（禁止内网 SSRF） */
  function isSafeUrl(urlStr: string): boolean {
    let parsed: URL
    try { parsed = new URL(urlStr) } catch { return false }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    const host = parsed.hostname.toLowerCase()
    /** 回环域名 */
    if (host === "localhost" || host.endsWith(".localhost") || host === "localtest.me" || host === "127.0.0.1.nip.io") return false
    /** IPv6 回环和特殊地址 */
    if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "0:0:0:0:0:ffff:127.0.0.1") return false
    /** IPv6 映射的 IPv4 地址 */
    if (host.startsWith("::ffff:")) return false
    /** 非 IPv4 点分十进制格式的 hostname 全部交给 DNS 解析后判定 */
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
      /** 标准点分十进制 IPv4（正则已保证恰好 4 段） */
      const parts = host.split(".")
      const a = Number(parts[0]!), b = Number(parts[1]!), c = Number(parts[2]!), d = Number(parts[3]!)
      /** 0.x.x.x / 127.x.x.x — 回环/保留 */
      if (a === 0 || a === 127) return false
      /** 10.x.x.x — A 类私有 */
      if (a === 10) return false
      /** 172.16-31.x.x — B 类私有 */
      if (a === 172 && b >= 16 && b <= 31) return false
      /** 192.168.x.x — C 类私有 */
      if (a === 192 && b === 168) return false
      /** 169.254.x.x — 链路本地 */
      if (a === 169 && b === 254) return false
      /** 100.64-127.x.x — 运营商级 NAT (CGN) */
      if (a === 100 && b >= 64 && b <= 127) return false
      /** 198.18-19.x.x — 基准测试保留 */
      if (a === 198 && (b === 18 || b === 19)) return false
      /** 224-239.x.x.x — 组播 */
      if (a >= 224 && a <= 239) return false
      /** 240-255.x.x.x — 保留 */
      if (a >= 240) return false
      /** 255.255.255.255 — 广播 */
      if (a === 255 && b === 255 && c === 255 && d === 255) return false
      return true
    }
    /** 非 IPv4 数字格式（域名、短 IPv4、十进制 IP、十六进制 IP）全部拒绝 */
    if (/^\d+$/.test(host)) return false
    if (/^0x[0-9a-f]+$/i.test(host)) return false
    /** 含有非标准字符的 hostname（如短 IPv4 "127.1"）也拒绝 */
    if (/^\d+\.\d*$/.test(host) || /^\d+\.\d+\.\d*$/.test(host)) return false
    return true
  }

  /** Provider 连通性测试核心逻辑 */
  async function doProviderTest(params: { baseUrl: string; apiKey: string; type: string; model?: string; customHeaders?: Record<string, string> }) {
    const { baseUrl, apiKey, type, model: testModel, customHeaders } = params
    if (!baseUrl || !apiKey || !type) {
      return { success: false, statusCode: 400, duration: 0, error: "baseUrl, apiKey, and type are required" }
    }
    const url = baseUrl.replace(/\/+$/, "")
    if (!isSafeUrl(url)) {
      return { success: false, statusCode: 400, duration: 0, error: "URL must be a valid public HTTP/HTTPS address" }
    }
    const start = performance.now()

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(customHeaders ?? {}),
    }

    let testUrl: string
    let method = "GET"
    /** 测试请求 body（仅 Anthropic 需要） */
    let reqBody: string | undefined

    if (type === "anthropic") {
      testUrl = `${url}/v1/messages`
      headers["x-api-key"] = apiKey
      headers["anthropic-version"] = "2023-06-01"
      method = "POST"
      reqBody = JSON.stringify({ model: testModel || "claude-sonnet-4-20250514", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
    } else if (type === "azure-openai") {
      testUrl = `${url}/openai/deployments?api-version=2024-02-01`
      headers["api-key"] = apiKey
    } else {
      testUrl = `${url}/models`
      headers["Authorization"] = `Bearer ${apiKey}`
    }

    try {
      const resp = await fetch(testUrl, { method, headers, body: reqBody, signal: AbortSignal.timeout(10000) })
      const duration = Math.round(performance.now() - start)

      if (resp.ok) {
        return { success: true, statusCode: resp.status, duration }
      }

      const errorBody = await resp.text().catch(() => "")
      return { success: false, statusCode: resp.status, duration, error: errorBody.slice(0, 500) }
    } catch (err) {
      const duration = Math.round(performance.now() - start)
      const message = err instanceof Error ? err.message : "Connection failed"
      return { success: false, statusCode: 0, duration, error: message }
    }
  }

  /** 创建前测试（apiKey 由前端传入） */
  fastify.post<{ Body: { baseUrl: string; apiKey: string; type: string; model?: string; customHeaders?: Record<string, string> } }>("/admin/providers/test", async (request, reply) => {
    if (!checkTestRate(request.ip)) return reply.status(429).send({ error: "Too many test requests. Try again later." })
    return doProviderTest(request.body)
  })

  /** 按 provider ID 测试（使用数据库中存储的真实 apiKey） */
  fastify.post<{ Params: { id: string } }>("/admin/providers/:id/test", async (request, reply) => {
    if (!checkTestRate(request.ip)) return reply.status(429).send({ error: "Too many test requests. Try again later." })
    const { id } = request.params
    const provider = fastify.db.getProvider(id)
    if (!provider) {
      return reply.status(404).send({ error: "Provider not found" })
    }
    return doProviderTest({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      type: provider.type,
      model: provider.models[0] || undefined,
      customHeaders: provider.customHeaders,
    })
  })

  // ========== Route Rules ==========

  fastify.get("/admin/routes", async () => {
    return fastify.db.getRouteRules()
  })

  fastify.post<{ Body: Omit<RouteRule, "id"> }>("/admin/routes", async (request, reply) => {
    const body = request.body
    if (!body.providerId) return reply.status(400).send({ error: "providerId is required" })
    /** 验证 providerId 存在 */
    if (!fastify.db.getProvider(body.providerId)) {
      return reply.status(400).send({ error: `Provider "${body.providerId}" not found` })
    }
    /** 验证 fallbacks 中的 providerId 存在 */
    if (body.fallbacks?.length) {
      for (const fb of body.fallbacks) {
        if (fb.providerId && !fastify.db.getProvider(fb.providerId)) {
          return reply.status(400).send({ error: `Fallback provider "${fb.providerId}" not found` })
        }
      }
    }
    const rule: RouteRule = {
      ...body,
      id: uuid(),
    }
    fastify.db.addRouteRule(rule)
    fastify.registry.invalidateRules()
    return reply.status(201).send(rule)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<RouteRule> }>("/admin/routes/:id", async (request, reply) => {
    const { id } = request.params
    const body = request.body
    if (body.providerId && !fastify.db.getProvider(body.providerId)) {
      return reply.status(400).send({ error: `Provider "${body.providerId}" not found` })
    }
    if (body.fallbacks?.length) {
      for (const fb of body.fallbacks) {
        if (fb.providerId && !fastify.db.getProvider(fb.providerId)) {
          return reply.status(400).send({ error: `Fallback provider "${fb.providerId}" not found` })
        }
      }
    }
    const updated = fastify.db.updateRouteRule(id, body)
    if (!updated) {
      return reply.status(404).send({ error: "Route rule not found" })
    }
    fastify.registry.invalidateRules()
    return reply.send(fastify.db.getRouteRule(id))
  })

  fastify.delete<{ Params: { id: string } }>("/admin/routes/:id", async (request, reply) => {
    const { id } = request.params
    fastify.db.deleteRouteRule(id)
    fastify.registry.invalidateRules()
    return reply.status(204).send()
  })

  /** 批量更新路由规则优先级 */
  fastify.put<{ Body: { id: string; priority: number }[] }>("/admin/routes/reorder", async (request, reply) => {
    const updates = request.body
    if (!Array.isArray(updates) || updates.length === 0) {
      return reply.status(400).send({ error: "Expected non-empty array of {id, priority}" })
    }
    for (const u of updates) {
      if (!u.id || typeof u.priority !== "number") {
        return reply.status(400).send({ error: "Each item must have id (string) and priority (number)" })
      }
    }
    /** 单事务批量更新，避免 N 次独立事务开销 */
    fastify.db.tx(() => {
      for (const u of updates) {
        fastify.db.updateRouteRule(u.id, { priority: u.priority })
      }
    })
    fastify.registry.invalidateRules()
    return { success: true }
  })

  // ========== Key Groups ==========

  fastify.get("/admin/key-groups", async () => {
    return fastify.db.getKeyGroupsWithCount()
  })

  fastify.post<{ Body: Omit<KeyGroup, "id" | "createdAt"> }>("/admin/key-groups", async (request, reply) => {
    const body = request.body
    if (!body.name) return reply.status(400).send({ error: "name is required" })
    const group: KeyGroup = {
      ...body,
      id: uuid(),
      createdAt: new Date().toISOString(),
    }
    try {
      fastify.db.addKeyGroup(group)
    } catch (e: unknown) {
      if (e instanceof Error && e.message?.includes("UNIQUE")) {
        return reply.status(400).send({ error: `Group name "${body.name}" already exists` })
      }
      throw e
    }
    invalidateNameCache()
    return reply.status(201).send(group)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<KeyGroup> }>("/admin/key-groups/:id", async (request, reply) => {
    const { id } = request.params
    const existing = fastify.db.getKeyGroup(id)
    if (!existing) {
      return reply.status(404).send({ error: "Key group not found" })
    }
    if (request.body.name !== undefined && !request.body.name) {
      return reply.status(400).send({ error: "name must not be empty" })
    }
    fastify.db.updateKeyGroup(id, request.body)
    invalidateAllKeyCache()
    invalidateNameCache()
    return fastify.db.getKeyGroup(id)
  })

  fastify.delete<{ Params: { id: string } }>("/admin/key-groups/:id", async (request, reply) => {
    const { id } = request.params
    const keyCount = fastify.db.getKeyCountByGroup(id)
    if (keyCount > 0) {
      return reply.status(400).send({ error: `Cannot delete: group has ${keyCount} API keys` })
    }
    fastify.db.deleteKeyGroup(id)
    invalidateNameCache()
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
      keySecret: rawKey,
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
    invalidateNameCache()
    return reply.status(201).send(key)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<ApiKey> }>("/admin/keys/:id", async (request, reply) => {
    const { id } = request.params
    const existing = fastify.db.getApiKey(id)
    if (!existing) {
      return reply.status(404).send({ error: "API key not found" })
    }
    /** 不允许通过 update 修改 keyHash 和 keyPrefix */
    const { keyHash: _kh, keyPrefix: _kp, ...update } = request.body as Record<string, unknown>
    /** 验证 groupId 存在 */
    if (update.groupId && !fastify.db.getKeyGroup(update.groupId as string)) {
      return reply.status(400).send({ error: `Key group "${update.groupId}" not found` })
    }
    fastify.db.updateApiKey(id, update)
    invalidateKeyCache(id)
    invalidateNameCache()
    return fastify.db.getApiKey(id)
  })

  fastify.delete<{ Params: { id: string } }>("/admin/keys/:id", async (request, reply) => {
    invalidateKeyCache(request.params.id)
    fastify.db.deleteApiKey(request.params.id)
    invalidateNameCache()
    return { success: true }
  })

  // ========== Logs ==========

  fastify.get<{ Querystring: { limit?: string; offset?: string; model?: string; providerId?: string; apiKeyId?: string; groupId?: string; status?: string; sort?: string; startTime?: string; endTime?: string; hasFallback?: string } }>("/admin/logs", async (request) => {
    const { limit, offset, model, providerId, apiKeyId, groupId, status, sort, startTime, endTime, hasFallback } = request.query
    const parsedLimit = limit ? parseInt(limit) : 100
    const parsedOffset = offset ? parseInt(offset) : 0
    const logs = fastify.db.getLogs({
      limit: Number.isNaN(parsedLimit) ? 100 : Math.max(1, Math.min(parsedLimit, 500)),
      offset: Number.isNaN(parsedOffset) ? 0 : Math.max(0, parsedOffset),
      model: model ?? undefined,
      providerId: providerId ?? undefined,
      apiKeyId: apiKeyId ?? undefined,
      groupId: groupId ?? undefined,
      status: status ?? undefined,
      sort: sort ?? undefined,
      startTime: startTime ?? undefined,
      endTime: endTime ?? undefined,
      hasFallback: hasFallback === "1" ? true : undefined,
    })
    /** 附加 provider/key/group 名称（使用缓存） */
    const { providerMap, keyMap, groupMap } = getNameMaps()
    return logs.map(log => ({
      ...log,
      providerName: providerMap.get(log.providerId) ?? log.providerId,
      keyName: log.apiKeyId ? (keyMap.get(log.apiKeyId) ?? null) : null,
      groupName: log.groupId ? (groupMap.get(log.groupId) ?? null) : null,
    }))
  })

  /** 获取单条日志详情（包含 input/output content） */
  fastify.get<{ Params: { id: string } }>("/admin/logs/:id", async (request, reply) => {
    const id = parseInt(request.params.id, 10)
    if (Number.isNaN(id)) return reply.status(400).send({ error: "Invalid log id" })
    const log = fastify.db.getLogDetail(id)
    if (!log) return reply.status(404).send({ error: "Log not found" })
    const { providerMap, keyMap, groupMap } = getNameMaps()
    return {
      ...log,
      providerName: providerMap.get(log.providerId) ?? log.providerId,
      keyName: log.apiKeyId ? (keyMap.get(log.apiKeyId) ?? null) : null,
      groupName: log.groupId ? (groupMap.get(log.groupId) ?? null) : null,
    }
  })

  fastify.get<{ Querystring: { apiKeyId?: string; groupId?: string } }>("/admin/stats", async (request) => {
    const { apiKeyId, groupId } = request.query
    return fastify.db.getLogStats({ apiKeyId, groupId })
  })

  // ========== Token 统计 ==========

  fastify.get("/admin/token-stats", async () => {
    return {
      summary: fastify.statsCache.getTokenStats(),
      byProvider: fastify.statsCache.getTokensByProvider(),
      byModel: fastify.statsCache.getTokensByModel(),
    }
  })

  fastify.get<{ Querystring: { hours?: string } }>("/admin/token-stats/hourly", async (request) => {
    const parsed = parseInt(request.query.hours ?? "24")
    const hours = Number.isNaN(parsed) ? 24 : parsed
    return fastify.db.getTokenStatsByHour(hours)
  })

  /** 按密钥分组统计 Token */
  fastify.get("/admin/token-stats/by-group", async () => {
    return fastify.statsCache.getTokensByGroup()
  })

  /** 按密钥统计 Token */
  fastify.get("/admin/token-stats/by-key", async () => {
    return fastify.statsCache.getTokensByKey()
  })

  // ========== 用量统计面板（SKU 余额/用量查询） ==========

  /** 获取用量统计面板数据 */
  fastify.get("/admin/sku-usage", async () => {
    const providers = fastify.db.getProviders().filter(p => p.enabled)
    const curlQueries = fastify.db.getCurlQueries()

    /** 计算本周/本月时间范围 */
    const now = new Date()
    const weekStart = new Date(now)
    weekStart.setUTCDate(now.getUTCDate() - now.getUTCDay())
    weekStart.setUTCHours(0, 0, 0, 0)
    const monthStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1)

    const weekStartStr = weekStart.toISOString().slice(0, 19).replace("T", " ")
    const monthStartStr = monthStart.toISOString().slice(0, 19).replace("T", " ")
    const tomorrowStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate() + 1).padStart(2, "0")} 00:00:00`

    /** 按服务商类型 + apiKey 分组，相同 apiKey 的 provider 合并为一条 */
    type MergedProvider = {
      id: string
      name: string
      baseUrl: string
      balance?: number
      currency?: string
      balanceError?: string
      grantedBalance?: number
      toppedUpBalance?: number
      quota?: Awaited<ReturnType<typeof queryZhipuQuota>>
      weeklyTokens: number
      monthlyTokens: number
    }

    const groups = new Map<string, {
      provider: string
      displayName: string
      providers: MergedProvider[]
    }>()

    /** 先按 (serviceType, apiKey) 收集所有 provider，合并用量 */
    const mergedMap = new Map<string, {
      serviceType: string
      apiKey: string
      names: string[]
      baseUrl: string
      providerIds: string[]
      weeklyTokens: number
      monthlyTokens: number
    }>()

    for (const p of providers) {
      const serviceType = detectProvider(p.baseUrl)
      /** 不支持余额查询的 provider 跳过 */
      if (serviceType === "unknown") continue
      const mergeKey = `${serviceType}:${p.apiKey}`

      const weeklyStats = fastify.db.getTokenStatsByProviderAndTimeRange(p.id, weekStartStr, tomorrowStr)
      const monthlyStats = fastify.db.getTokenStatsByProviderAndTimeRange(p.id, monthStartStr, tomorrowStr)
      const weeklyTokens = weeklyStats.inputTokens + weeklyStats.outputTokens + weeklyStats.cacheCreationTokens + weeklyStats.cacheReadTokens
      const monthlyTokens = monthlyStats.inputTokens + monthlyStats.outputTokens + monthlyStats.cacheCreationTokens + monthlyStats.cacheReadTokens

      if (mergedMap.has(mergeKey)) {
        const entry = mergedMap.get(mergeKey)!
        entry.names.push(p.name)
        entry.providerIds.push(p.id)
        entry.weeklyTokens += weeklyTokens
        entry.monthlyTokens += monthlyTokens
      } else {
        mergedMap.set(mergeKey, {
          serviceType,
          apiKey: p.apiKey,
          names: [p.name],
          baseUrl: p.baseUrl,
          providerIds: [p.id],
          weeklyTokens,
          monthlyTokens,
        })
      }
    }

    /** 并行查询所有合并后的余额（每个唯一 apiKey 只查一次） */
    const balancePromises = [...mergedMap.values()].map(async (entry) => {
      const p = providers.find(x => x.apiKey === entry.apiKey && detectProvider(x.baseUrl) === entry.serviceType)!
      const balance = await queryProviderBalance(p)
      let quota: Awaited<ReturnType<typeof queryZhipuQuota>> | undefined
      if (entry.serviceType === "zhipu") {
        quota = await queryZhipuQuota(p)
      }
      return { mergeKey: `${entry.serviceType}:${entry.apiKey}`, balance, quota }
    })
    const balanceResults = await Promise.all(balancePromises)
    const balanceMap = new Map(balanceResults.map(r => [r.mergeKey, r]))

    /** 将合并后的数据放入分组 */
    for (const [mergeKey, entry] of mergedMap) {
      const groupKey = entry.serviceType
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          provider: entry.serviceType,
          displayName: getProviderDisplayName(entry.serviceType as import("../types.ts").ServiceProvider),
          providers: [],
        })
      }
      const group = groups.get(groupKey)!
      const balanceInfo = balanceMap.get(mergeKey)

      group.providers.push({
        id: entry.providerIds.join(","),
        name: entry.names.join(" / "),
        baseUrl: entry.baseUrl,
        balance: balanceInfo?.balance.success ? balanceInfo.balance.balance : undefined,
        currency: balanceInfo?.balance.success ? balanceInfo.balance.currency : undefined,
        balanceError: balanceInfo?.balance.success ? undefined : balanceInfo?.balance.error,
        grantedBalance: balanceInfo?.balance.success ? balanceInfo.balance.grantedBalance : undefined,
        toppedUpBalance: balanceInfo?.balance.success ? balanceInfo.balance.toppedUpBalance : undefined,
        quota: balanceInfo?.quota,
        weeklyTokens: entry.weeklyTokens,
        monthlyTokens: entry.monthlyTokens,
      })
    }

    /** 查询 cURL 配置 */
    const curlResults = await Promise.all(
      curlQueries.map(async (q) => {
        const result = await queryWithCurl(q)
        return { id: q.id, name: q.name, result }
      })
    )

    /** 计算合计 */
    const groupArray = [...groups.values()].map(g => {
      const totalBalance = g.providers.reduce((sum, p) => sum + (p.balance ?? 0), 0)
      const totalWeeklyTokens = g.providers.reduce((sum, p) => sum + p.weeklyTokens, 0)
      const totalMonthlyTokens = g.providers.reduce((sum, p) => sum + p.monthlyTokens, 0)
      return {
        ...g,
        totalBalance: totalBalance > 0 ? totalBalance : undefined,
        totalWeeklyTokens,
        totalMonthlyTokens,
      }
    })

    return {
      groups: groupArray,
      curlQueries: curlResults,
    }
  })

  // ---------- cURL 查询配置 CRUD ----------

  fastify.get("/admin/curl-queries", async () => {
    return fastify.db.getCurlQueries()
  })

  fastify.post<{ Body: { name: string; curlString: string } }>("/admin/curl-queries", async (request, reply) => {
    const { name, curlString } = request.body
    if (!name || !curlString) {
      return reply.status(400).send({ error: "名称和 cURL 命令不能为空" })
    }

    const parsed = parseCurl(curlString)
    if (!parsed.url) {
      return reply.status(400).send({ error: "无法解析 cURL 命令" })
    }

    const config = {
      id: uuid(),
      name,
      url: parsed.url,
      method: parsed.method,
      headers: parsed.headers,
      body: parsed.body,
    }

    fastify.db.addCurlQuery(config)
    return reply.status(201).send(config)
  })

  fastify.put<{ Params: { id: string }; Body: Partial<{ name: string; url: string; method: string; headers: Record<string, string>; body?: string }> }>("/admin/curl-queries/:id", async (request, reply) => {
    const existing = fastify.db.getCurlQuery(request.params.id)
    if (!existing) return reply.status(404).send({ error: "Not found" })

    fastify.db.updateCurlQuery(request.params.id, request.body)
    return fastify.db.getCurlQuery(request.params.id)
  })

  fastify.delete<{ Params: { id: string } }>("/admin/curl-queries/:id", async (request, reply) => {
    fastify.db.deleteCurlQuery(request.params.id)
    return reply.status(204).send()
  })

  fastify.post<{ Body: { curlString: string } }>("/admin/curl-queries/test", async (request, reply) => {
    const { curlString } = request.body
    if (!curlString) {
      return reply.status(400).send({ error: "cURL 命令不能为空" })
    }

    const parsed = parseCurl(curlString)
    if (!parsed.url) {
      return reply.status(400).send({ error: "无法解析 cURL 命令" })
    }

    const result = await queryWithCurl({
      id: "test",
      name: "test",
      url: parsed.url,
      method: parsed.method,
      headers: parsed.headers,
      body: parsed.body,
    })

    return result
  })

  // ========== SSE 实时事件流 ==========

  /** 活跃请求追踪：存储完整信息用于 SSE 重连回放 */
  interface ActiveRequest {
    providerId: string
    providerName: string
    model: string
    targetModel: string
    input: string
    rulePattern: string | null
    keyName?: string | null
    groupName?: string | null
    startedAt: number
    /** 已累积的输出文本（截断至 50000 字符防止内存膨胀） */
    output: string
  }
  const activeRequests = new Map<string, ActiveRequest>()

  /** 上游 API 调用追踪：requestId -> providerId */
  const upstreamRequests = new Map<string, string>()

  /** 并发历史环形缓冲区：并发变化时记录快照，最多保留 300 个 */
  interface ConcurrencySnapshot {
    /** 时间标签 HH:MM:SS */
    time: string
    /** 各 provider 两层并发数 */
    providers: { id: string; gateway: number; upstream: number }[]
    /** EMA 平滑后的输出速率（chars/s） */
    outputRate: number
  }
  const maxSnapshots = 300
  const concurrencySnapshots: ConcurrencySnapshot[] = []

  /** 输出速率 EMA 追踪 */
  let windowOutputChars = 0
  let lastOutputRateTime = 0
  let smoothedRate = 0
  const EMA_ALPHA = 0.3
  const EMA_DECAY = 0.85

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

  /** 计算当前 EMA 平滑输出速率并重置累积窗口 */
  function calcOutputRate(): number {
    const nowMs = Date.now()
    const elapsedMs = lastOutputRateTime > 0 ? nowMs - lastOutputRateTime : 0
    lastOutputRateTime = nowMs
    if (elapsedMs > 0 && windowOutputChars > 0) {
      const instantRate = windowOutputChars / (elapsedMs / 1000)
      smoothedRate = smoothedRate === 0 ? instantRate : EMA_ALPHA * instantRate + (1 - EMA_ALPHA) * smoothedRate
    } else if (windowOutputChars === 0) {
      smoothedRate *= EMA_DECAY
      if (smoothedRate < 0.5) smoothedRate = 0
    }
    windowOutputChars = 0
    return Math.round(smoothedRate)
  }

  /** 记录当前并发快照到环形缓冲区 */
  function recordSnapshot() {
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
    const providers = fastify.registry.getConcurrencyStatus()
    const gatewayCounts = countActiveByProvider()
    const upstreamCounts = countUpstreamByProvider()
    const outputRate = calcOutputRate()
    concurrencySnapshots.push({
      time,
      providers: providers.map(p => ({
        id: p.id,
        name: p.name,
        gateway: gatewayCounts.get(p.id) ?? 0,
        upstream: upstreamCounts.get(p.id) ?? 0,
      })),
      outputRate,
    })
    if (concurrencySnapshots.length > maxSnapshots) concurrencySnapshots.shift()
  }

  /** request_stats 推送防抖：避免每个请求结束都触发 4 个聚合查询 */
  let statsTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleStatsPush() {
    if (statsTimer) return
    statsTimer = setTimeout(() => {
      statsTimer = null
      const requests = fastify.statsCache.getLogStats()
      emitEvent({
        type: "request_stats",
        requests,
        byProvider: fastify.statsCache.getByProvider(),
        byModel: fastify.statsCache.getByModel(),
        tokenStats: fastify.statsCache.getTokenStats(),
        tokensByProvider: fastify.statsCache.getTokensByProvider(),
        tokensByModel: fastify.statsCache.getTokensByModel(),
      })
    }, 3000)
    statsTimer.unref()
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
    return {
      providers: providerStatus.map(p => ({
        id: p.id,
        name: p.name,
        max: p.max,
        gateway: gatewayCounts.get(p.id) ?? 0,
        upstream: upstreamCounts.get(p.id) ?? 0,
        models: [...(modelMap.get(p.id)?.values() ?? [])],
      })),
      outputRate: smoothedRate,
    }
  }

  /** 事件监听：维护活跃请求表，并发变化时记录快照并推送 */
  onEvent((event: BusEvent) => {
    if (event.type === "request_start") {
      activeRequests.set(event.requestId, {
        providerId: event.providerId ?? "",
        providerName: event.provider,
        model: event.model,
        targetModel: event.targetModel,
        input: event.input,
        rulePattern: event.rulePattern,
        keyName: event.keyName,
        groupName: event.groupName,
        startedAt: Date.now(),
        output: "",
      })
      recordSnapshot()
      pushConcurrency()
    } else if (event.type === "request_end") {
      activeRequests.delete(event.requestId)
      /** 增量更新 total 计数器（避免全表 COUNT/SUM） */
      fastify.statsCache.recordRequest()
      /** 使统计缓存失效 */
      fastify.statsCache.onRequestEnd()
      recordSnapshot()
      pushConcurrency()
      /** 防抖推送统计数据 */
      scheduleStatsPush()
    } else if (event.type === "request_stream") {
      /** 累加输出字符数用于计算输出速率 */
      windowOutputChars += event.text.length
      /** 累加输出文本到对应活跃请求，用于 SSE 重连回放 */
      const req = activeRequests.get(event.requestId)
      if (req && req.output.length < 50000) req.output += event.text
    } else if (event.type === "upstream_start") {
      upstreamRequests.set(event.requestId, event.providerId)
      /** 更新活跃请求的 providerId（可能发生 fallback 切换） */
      const req = activeRequests.get(event.requestId)
      if (req) {
        req.providerId = event.providerId
        if (event.providerName) req.providerName = event.providerName
      }
      recordSnapshot()
      pushConcurrency()
    } else if (event.type === "upstream_end") {
      upstreamRequests.delete(event.requestId)
      recordSnapshot()
      pushConcurrency()
    }
  })

  /** 并发推送回调注册：SSE 连接注册 safeWrite，并发变化时主动推送 */
  type ConcurrencyWriter = (data: string) => void
  const concurrencyWriters = new Set<ConcurrencyWriter>()

  function pushConcurrency() {
    if (concurrencyWriters.size === 0) return
    const payload = buildConcurrencyPayload()
    const data = `data: ${JSON.stringify({ type: "concurrency", ...payload })}\n\n`
    for (const write of concurrencyWriters) {
      try { write(data) } catch { /* connection already closed */ }
    }
  }

  /** SSE 最大连接数，超出时拒绝新连接 */
  const MAX_SSE_CONNECTIONS = 20
  let sseConnectionCount = 0
  /** 活跃 SSE 连接的 raw response，用于 shutdown 时主动关闭 */
  const activeSSEConnections = new Set<import("node:http").ServerResponse>()

  /** 暴露关闭 SSE 连接的方法给 shutdown 流程使用 */
  fastify.decorate("closeSSEConnections", () => {
    for (const raw of activeSSEConnections) {
      raw.destroy()
    }
    activeSSEConnections.clear()
  })

  fastify.get("/admin/events", async (request, reply) => {
    if (sseConnectionCount >= MAX_SSE_CONNECTIONS) {
      return reply.status(503).send({ error: "Too many SSE connections" })
    }

    let unsubscribe: (() => void) | undefined
    let unregisterConcurrency: (() => void) | undefined
    /** 背压标记：write 返回 false 时暂停写入，drain 时恢复 */
    let buffered = false
    /** 防止 cleanup 重复触发（error + close 可能连续触发） */
    let cleaned = false

    sseConnectionCount++

    /** 清理 SSE 资源 */
    function cleanup() {
      if (cleaned) return
      cleaned = true
      if (unsubscribe) { unsubscribe(); unsubscribe = undefined }
      if (unregisterConcurrency) { unregisterConcurrency(); unregisterConcurrency = undefined }
      buffered = false
      sseConnectionCount--
      activeSSEConnections.delete(raw)
    }

    /** 安全写入：检查背压，缓冲满时丢弃后续数据 */
    function safeWrite(data: string): boolean {
      if (buffered || !raw.writable) return false
      const ok = raw.write(data)
      if (!ok) {
        buffered = true
        raw.once("drain", () => { buffered = false })
      }
      return ok
    }

    reply.hijack()
    const raw = reply.raw

    activeSSEConnections.add(raw)

    /** 处理底层连接错误（如 ECONNRESET） */
    request.raw.on("error", cleanup)

    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    safeWrite("data: {\"type\":\"connected\"}\n\n")

    /** 推送历史并发快照，前端刷新后可恢复图表 */
    if (concurrencySnapshots.length > 0) {
      safeWrite(`data: ${JSON.stringify({ type: "concurrency_history", snapshots: concurrencySnapshots })}\n\n`)
    }

    /** 推送当前并发状态 */
    const payload = buildConcurrencyPayload()
    safeWrite(`data: ${JSON.stringify({ type: "concurrency", ...payload })}\n\n`)

    /** 回放所有活跃请求，前端刷新后可恢复正在进行的请求面板 */
    for (const [requestId, req] of activeRequests) {
      safeWrite(`data: ${JSON.stringify({
        type: "request_start",
        requestId,
        model: req.model,
        targetModel: req.targetModel,
        provider: req.providerName,
        providerId: req.providerId,
        input: req.input,
        rulePattern: req.rulePattern,
        keyName: req.keyName,
        groupName: req.groupName,
        startedAt: req.startedAt,
        output: req.output || undefined,
      })}\n\n`)
    }

    /** 注册并发推送：并发变化时主动推送，不再定时轮询 */
    const concurrencyWriter: ConcurrencyWriter = (data) => {
      try {
        safeWrite(data)
      } catch {
        cleanup()
      }
    }
    concurrencyWriters.add(concurrencyWriter)
    unregisterConcurrency = () => { concurrencyWriters.delete(concurrencyWriter) }

    /** 监听请求事件并转发（使用预序列化，避免每个连接重复 JSON.stringify） */
    unsubscribe = onSerializedEvent((data) => {
      try {
        safeWrite(data)
      } catch {
        cleanup()
      }
    })

    /** 客户端断开时清理 */
    request.raw.on("close", cleanup)
  })
}

import type { FastifyRequest, FastifyReply } from "fastify"
import type { GatewayDB } from "./db.ts"
import type { AuthContext } from "./types.ts"
import type { ConfigManager } from "./config.ts"

/** 从请求头中提取 API Key（兼容 Anthropic 和 OpenAI SDK） */
function extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  /** Anthropic SDK 使用 x-api-key */
  const xApiKey = headers["x-api-key"]
  if (typeof xApiKey === "string" && xApiKey.startsWith("sk-")) return xApiKey

  /** OpenAI SDK 使用 Authorization: Bearer xxx */
  const auth = headers["authorization"]
  if (typeof auth === "string") {
    const match = auth.match(/^Bearer\s+(sk-.+)$/i)
    if (match) return match[1]!
  }

  return null
}

/** SHA-256 哈希 */
function sha256(input: string): string {
  return new Bun.CryptoHasher("sha256").update(input).digest("hex")
}

/** 生成随机 session token */
function generateSessionToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
}

/** 内存中的 session 存储：token -> { username, expiresAt } */
const sessions = new Map<string, { username: string; expiresAt: number }>()

/** Session 有效期：7 天 */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 定期清理过期 session（每小时一次） */
const SESSION_CLEANUP_MS = 60 * 60 * 1000
function cleanupExpiredSessions() {
  const now = Date.now()
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token)
  }
}
setInterval(cleanupExpiredSessions, SESSION_CLEANUP_MS).unref()

/** 创建 session，返回 token */
export function createSession(username: string): string {
  const now = Date.now()
  const token = generateSessionToken()
  sessions.set(token, { username, expiresAt: now + SESSION_TTL_MS })
  return token
}

/** 验证 session token，返回 username 或 null */
function verifySession(token: string): string | null {
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt < Date.now()) {
    sessions.delete(token)
    return null
  }
  return session.username
}

/** 销毁 session */
export function destroySession(token: string): void {
  sessions.delete(token)
}

/** 销毁所有 session（修改密码后调用） */
export function destroyAllSessions(): void {
  sessions.clear()
}

/** 从 cookie 中提取 admin_token */
export function extractSessionToken(headers: Record<string, string | string[] | undefined>): string | null {
  const cookie = headers["cookie"]
  if (typeof cookie !== "string") return null
  for (const part of cookie.split(";")) {
    const trimmed = part.trim()
    if (trimmed.startsWith("admin_token=")) {
      return trimmed.slice("admin_token=".length)
    }
  }
  return null
}

/** API Key 内存缓存：hash -> { context, expiresAt } */
const keyCache = new Map<string, { context: AuthContext; expiresAt: number }>()
/** 缓存有效期：30 秒（平衡实时性与性能） */
const KEY_CACHE_TTL_MS = 30_000

/** 清除指定 keyId 的缓存（key 被禁用/删除/修改时调用） */
export function invalidateKeyCache(keyId: string) {
  for (const [hash, entry] of keyCache) {
    if (entry.context.keyId === keyId) {
      keyCache.delete(hash)
    }
  }
}

/** 清除所有 key 缓存（group 被修改时调用） */
export function invalidateAllKeyCache() {
  keyCache.clear()
}

/** 定期清理过期的 API Key 缓存条目（每 60 秒） */
setInterval(() => {
  const now = Date.now()
  for (const [hash, entry] of keyCache) {
    if (entry.expiresAt < now) keyCache.delete(hash)
  }
}, 60_000).unref()

/** API 路由认证钩子工厂 */
export function createApiAuthHook(db: GatewayDB, configManager: ConfigManager) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const rawKey = extractApiKey(request.headers)

    /** 无 Key */
    if (!rawKey) {
      if (!configManager.get().authRequired) {
        request.authContext = null
        return
      }
      return reply.status(401).send({
        type: "error",
        error: { type: "authentication_error", message: "API key required. Pass x-api-key or Authorization: Bearer header." },
      })
    }

    /** 查找 Key */
    const hash = sha256(rawKey)

    /** 检查缓存 */
    const cached = keyCache.get(hash)
    if (cached && cached.expiresAt > Date.now()) {
      request.authContext = cached.context
      /** 缓存命中时概率性更新 last_used_at，减少高频请求下的 DB 写入 */
      if (Math.random() < 0.1) db.updateKeyLastUsed(cached.context.keyId)
      return
    }

    const keyRecord = db.getApiKeyByHash(hash)
    if (!keyRecord || !keyRecord.enabled) {
      return reply.status(401).send({
        type: "error",
        error: { type: "authentication_error", message: "Invalid or disabled API key." },
      })
    }

    /** 解析分组 */
    const group = db.getKeyGroup(keyRecord.groupId)

    const context = {
      keyId: keyRecord.id,
      groupId: keyRecord.groupId,
      groupName: group?.name ?? "",
      keyName: keyRecord.name,
      keyLimits: { dailyTokenLimit: keyRecord.dailyTokenLimit, monthlyTokenLimit: keyRecord.monthlyTokenLimit, rpmLimit: keyRecord.rpmLimit },
      groupLimits: { dailyTokenLimit: group?.dailyTokenLimit ?? 0, monthlyTokenLimit: group?.monthlyTokenLimit ?? 0, rpmLimit: group?.rpmLimit ?? 0 },
    } satisfies AuthContext

    request.authContext = context

    /** 写入缓存 */
    keyCache.set(hash, { context, expiresAt: Date.now() + KEY_CACHE_TTL_MS })

    /** 更新最后使用时间 */
    db.updateKeyLastUsed(keyRecord.id)
  }
}

/** Admin 路由认证钩子工厂 */
export function createAdminAuthHook(configManager: ConfigManager) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    /** 只对 /admin/ 路径生效（忽略查询参数） */
    const path = request.url.split("?")[0]!
    if (!path.startsWith("/admin/")) return

    /** 未初始化管理员时放行（让引导页能工作） */
    if (!configManager.isAdminInitialized()) return

    /** 白名单路由始终放行 */
    if (path === "/admin/init-check" || path === "/admin/init" || path === "/admin/login") return

    /** Session token 验证（从 cookie 中读取） */
    const token = extractSessionToken(request.headers)
    if (token) {
      const username = verifySession(token)
      if (username) return
    }

    /** 未认证 */
    return reply.status(401).send({ error: "Authentication required" })
  }
}

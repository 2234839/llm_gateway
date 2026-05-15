import type { GatewayDB } from "./db.ts"
import type { AuthContext } from "./types.ts"

interface QuotaResult {
  allowed: boolean
  reason?: string
  retryAfterMs?: number
}

/** 有效限额：Key 级别 > 分组级别 > 0(不限) */
function effectiveLimit(keyLimit: number, groupLimit: number): number {
  if (keyLimit > 0) return keyLimit
  if (groupLimit > 0) return groupLimit
  return 0
}

/** 内存 RPM 滑动窗口：keyId -> 请求时间戳数组 */
const rpmWindows = new Map<string, number[]>()

/** Token 用量缓存：keyId -> { usage, expiresAt }，减少高频请求的 DB 查询 */
const usageCache = new Map<string, { daily: number; monthly: number; expiresAt: number }>()
/** 缓存有效期 30 秒 */
const USAGE_CACHE_TTL_MS = 30_000

/** 定期清理 RPM 和 usage 缓存中已删除 key 的残留条目 */
setInterval(() => {
  const now = Date.now()
  const cutoff = now - 60_000
  for (const [keyId, window] of rpmWindows) {
    if (window.length === 0 || window[window.length - 1]! < cutoff) {
      rpmWindows.delete(keyId)
    }
  }
  for (const [keyId, val] of usageCache) {
    if (val.expiresAt < now) usageCache.delete(keyId)
  }
}, 5 * 60_000).unref()

/**
 * 记录一次 RPM 请求（在 checkQuota 通过后调用）。
 * 仅在有 RPM 限制时记录，避免无限制 key 的窗口无限增长。
 */
export function recordRpmRequest(keyId: string, keyRpmLimit: number, groupRpmLimit: number) {
  const effective = effectiveLimit(keyRpmLimit, groupRpmLimit)
  if (effective <= 0) return
  const now = Date.now()
  let window = rpmWindows.get(keyId)
  if (!window) {
    window = [now]
    rpmWindows.set(keyId, window)
    return
  }
  window.push(now)
}

/** 清理过期的 RPM 滑动窗口条目（惰性清理） */
function cleanRpmWindow(keyId: string, windowMs: number) {
  const window = rpmWindows.get(keyId)
  if (!window) return
  const cutoff = Date.now() - windowMs
  /** 大部分请求在窗口尾部，从后往前找 cutoff 位置 */
  let cutIdx = 0
  for (let i = 0; i < window.length; i++) {
    if (window[i]! >= cutoff) { cutIdx = i; break }
    cutIdx = i + 1
  }
  if (cutIdx > 0) window.splice(0, cutIdx)
  if (window.length === 0) rpmWindows.delete(keyId)
}

/** 检查 API Key 的配额是否允许本次请求 */
export function checkQuota(db: GatewayDB, auth: AuthContext | null): QuotaResult {
  if (!auth) return { allowed: true }

  const { keyLimits, groupLimits } = auth

  /** RPM 检查：使用内存滑动窗口，避免 TOCTOU */
  const effectiveRpm = effectiveLimit(keyLimits.rpmLimit, groupLimits.rpmLimit)
  if (effectiveRpm > 0) {
    cleanRpmWindow(auth.keyId, 60_000)
    const window = rpmWindows.get(auth.keyId)
    const rpm = window?.length ?? 0
    if (rpm >= effectiveRpm) {
      return { allowed: false, reason: `Rate limit exceeded: ${rpm}/${effectiveRpm} requests per minute.`, retryAfterMs: 60_000 }
    }
  }

  /** 需要查询 DB 的配额检查，使用缓存减少高频请求下的查询次数 */
  const effectiveDaily = effectiveLimit(keyLimits.dailyTokenLimit, groupLimits.dailyTokenLimit)
  const effectiveMonthly = effectiveLimit(keyLimits.monthlyTokenLimit, groupLimits.monthlyTokenLimit)

  if (effectiveDaily > 0 || effectiveMonthly > 0) {
    const now = Date.now()
    /** 惰性清理过期缓存条目，避免失效 key 的缓存无限增长 */
    if (usageCache.size > 500) {
      for (const [key, val] of usageCache) {
        if (val.expiresAt < now) usageCache.delete(key)
      }
    }
    let cached = usageCache.get(auth.keyId)
    if (!cached || cached.expiresAt < now) {
      cached = {
        daily: effectiveDaily > 0 ? db.getDailyKeyUsage(auth.keyId) : 0,
        monthly: effectiveMonthly > 0 ? db.getMonthlyKeyUsage(auth.keyId) : 0,
        expiresAt: now + USAGE_CACHE_TTL_MS,
      }
      usageCache.set(auth.keyId, cached)
    }

    if (effectiveDaily > 0 && cached.daily >= effectiveDaily) {
      return { allowed: false, reason: `Daily token quota exceeded: ${cached.daily}/${effectiveDaily}.`, retryAfterMs: 86400000 }
    }
    if (effectiveMonthly > 0 && cached.monthly >= effectiveMonthly) {
      return { allowed: false, reason: `Monthly token quota exceeded: ${cached.monthly}/${effectiveMonthly}.` }
    }
  }

  return { allowed: true }
}

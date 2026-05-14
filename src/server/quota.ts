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

/** 检查 API Key 的配额是否允许本次请求 */
export function checkQuota(db: GatewayDB, auth: AuthContext | null): QuotaResult {
  if (!auth) return { allowed: true }

  const keyRecord = db.getApiKey(auth.keyId)
  if (!keyRecord) return { allowed: true }

  const group = db.getKeyGroup(auth.groupId)

  /** RPM 检查 */
  const effectiveRpm = effectiveLimit(keyRecord.rpmLimit, group?.rpmLimit ?? 0)
  if (effectiveRpm > 0) {
    const rpm = db.getKeyRpmCount(auth.keyId)
    if (rpm >= effectiveRpm) {
      return { allowed: false, reason: `Rate limit exceeded: ${rpm}/${effectiveRpm} requests per minute.`, retryAfterMs: 60000 }
    }
  }

  /** 每日 Token 配额检查 */
  const effectiveDaily = effectiveLimit(keyRecord.dailyTokenLimit, group?.dailyTokenLimit ?? 0)
  if (effectiveDaily > 0) {
    const used = db.getDailyKeyUsage(auth.keyId)
    if (used >= effectiveDaily) {
      return { allowed: false, reason: `Daily token quota exceeded: ${used}/${effectiveDaily}.`, retryAfterMs: 86400000 }
    }
  }

  /** 每月 Token 配额检查 */
  const effectiveMonthly = effectiveLimit(keyRecord.monthlyTokenLimit, group?.monthlyTokenLimit ?? 0)
  if (effectiveMonthly > 0) {
    const used = db.getMonthlyKeyUsage(auth.keyId)
    if (used >= effectiveMonthly) {
      return { allowed: false, reason: `Monthly token quota exceeded: ${used}/${effectiveMonthly}.` }
    }
  }

  return { allowed: true }
}

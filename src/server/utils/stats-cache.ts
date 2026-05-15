import type { TokenStats } from "../types.ts"
import type { GatewayDB } from "../db.ts"

interface ProviderStat {
  providerId: string
  providerName: string
  total: number
  today: number
}

interface ModelStat {
  model: string
  targetModel: string
  total: number
  today: number
}

interface TokenStatWithToday {
  total: TokenStats
  today: TokenStats
}

interface ProviderTokenStat extends TokenStatWithToday {
  providerId: string
  providerName: string
}

interface ModelTokenStat extends TokenStatWithToday {
  model: string
  targetModel: string
}

interface KeyTokenStat extends TokenStatWithToday {
  keyId: string
  keyName: string
  groupId: string
  groupName: string
}

interface GroupTokenStat extends TokenStatWithToday {
  groupId: string
  groupName: string
}

interface LogStats {
  total: number
  today: number
  todayErrors: number
  todayAvgMs: number
  todayP50Ms: number
  todayP95Ms: number
  todayP99Ms: number
}

/** 聚合统计数据缓存：通过事件驱动增量更新，避免频繁全表扫描 */
export class StatsCache {
  private db: GatewayDB
  /** 上次从 DB 全量加载的时间戳（日期字符串 YYYY-MM-DD），跨日时重置 */
  private lastLoadDate = ""
  private _logStats: LogStats | null = null
  private _byProvider: ProviderStat[] | null = null
  private _byModel: ModelStat[] | null = null
  private _tokenStats: { total: TokenStats; today: TokenStats } | null = null
  private _tokensByProvider: ProviderTokenStat[] | null = null
  private _tokensByModel: ModelTokenStat[] | null = null
  private _tokensByGroup: GroupTokenStat[] | null = null
  private _tokensByKey: KeyTokenStat[] | null = null
  /** 节流：距上次失效至少 5 秒，避免每个请求都触发全表扫描 */
  private _lastInvalidateMs = 0
  private static THROTTLE_MS = 5000

  /** 内存增量：total 请求计数，-1 表示未初始化 */
  private _totalCount = -1

  constructor(db: GatewayDB) {
    this.db = db
  }

  /** 检查是否跨日（UTC），跨日则清空缓存 */
  private checkDate() {
    const now = new Date()
    const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`
    if (today !== this.lastLoadDate) {
      this.invalidate()
      this.lastLoadDate = today
    }
  }

  /** 失效所有缓存（DB 数据变更时调用，如 admin 修改配置） */
  invalidate() {
    this._logStats = null
    this._byProvider = null
    this._byModel = null
    this._tokenStats = null
    this._tokensByProvider = null
    this._tokensByModel = null
    this._tokensByGroup = null
    this._tokensByKey = null
    this._totalCount = -1
  }

  /** request_end 事件后的增量失效：节流，距上次失效至少 5 秒 */
  onRequestEnd() {
    this.checkDate()
    const now = Date.now()
    if (now - this._lastInvalidateMs < StatsCache.THROTTLE_MS) return
    this._lastInvalidateMs = now
    this._logStats = null
    this._byProvider = null
    this._byModel = null
    this._tokenStats = null
    this._tokensByProvider = null
    this._tokensByModel = null
    this._tokensByGroup = null
    this._tokensByKey = null
  }

  /** 记录一次请求，用于增量更新 total 计数器 */
  recordRequest() {
    this._totalCount = Math.max(0, this._totalCount) + 1
  }

  getLogStats(): LogStats {
    this.checkDate()
    if (!this._logStats) {
      /** 有增量 total 时跳过全表 COUNT(*) */
      const hasIncremental = this._totalCount >= 0
      this._logStats = this.db.getLogStats(hasIncremental ? { skipTotal: true } : undefined)
      if (hasIncremental) {
        this._logStats.total = this._totalCount
      } else {
        /** 首次从 DB 加载时，初始化增量计数器 */
        this._totalCount = this._logStats.total
      }
    }
    return this._logStats
  }

  getByProvider(): ProviderStat[] {
    this.checkDate()
    if (!this._byProvider) {
      this._byProvider = this.db.getLogStatsByProvider()
    }
    return this._byProvider
  }

  getByModel(): ModelStat[] {
    this.checkDate()
    if (!this._byModel) {
      this._byModel = this.db.getLogStatsByModel()
    }
    return this._byModel
  }

  getTokenStats(): { total: TokenStats; today: TokenStats } {
    this.checkDate()
    if (!this._tokenStats) {
      this._tokenStats = this.db.getTokenStats()
    }
    return this._tokenStats
  }

  getTokensByProvider(): ProviderTokenStat[] {
    this.checkDate()
    if (!this._tokensByProvider) {
      this._tokensByProvider = this.db.getTokenStatsByProvider()
    }
    return this._tokensByProvider
  }

  getTokensByModel(): ModelTokenStat[] {
    this.checkDate()
    if (!this._tokensByModel) {
      this._tokensByModel = this.db.getTokenStatsByModel()
    }
    return this._tokensByModel
  }

  getTokensByGroup(): GroupTokenStat[] {
    this.checkDate()
    if (!this._tokensByGroup) {
      this._tokensByGroup = this.db.getTokenStatsByGroup()
    }
    return this._tokensByGroup
  }

  getTokensByKey(): KeyTokenStat[] {
    this.checkDate()
    if (!this._tokensByKey) {
      this._tokensByKey = this.db.getTokenStatsByKey()
    }
    return this._tokensByKey
  }

  /** /health 端点所需的完整数据 */
  getHealthData() {
    return {
      logStats: this.getLogStats(),
      byProvider: this.getByProvider(),
      byModel: this.getByModel(),
      tokenStats: this.getTokenStats(),
      tokensByProvider: this.getTokensByProvider(),
      tokensByModel: this.getTokensByModel(),
    }
  }
}

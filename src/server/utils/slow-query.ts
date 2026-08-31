/** 慢 SQL 监控：记录、告警、持久化到 SQLite，供管理面板查看 */

export interface SlowQueryRecord {
  id: number
  /** 触发时间 ISO 字符串 */
  at: string
  /** SQL 原文（含参数占位符） */
  sql: string
  /** 实际绑定参数（JSON，截断保护） */
  params: string
  /** 执行耗时 ms */
  durationMs: number
}

/** 内存环形缓冲上限，超过丢弃最旧记录（DB 侧另有保留上限） */
const MAX_MEMORY_RECORDS = 200
/** 单条参数序列化上限，防大 blob/长文本撑爆记录 */
const MAX_PARAM_JSON_LEN = 2000

export class SlowQueryMonitor {
  private records: SlowQueryRecord[] = []
  private nextId = 1
  /** 每条 SQL 的聚合计数：sql -> { count, maxMs, lastAt }，用于识别高频慢点 */
  private agg = new Map<string, { count: number; maxMs: number; lastAt: string }>()
  /** 同一条 SQL 的告警冷却：避免每分钟 prune 都刷屏 */
  private cooldown = new Map<string, number>()
  private listeners = new Set<(r: SlowQueryRecord) => void>()

  constructor(
    private db: { runSlowQueryLog: (r: Omit<SlowQueryRecord, "id">) => number },
    /** 阈值 getter：每次执行时读取，配置变更即时生效 */
    private thresholdMs: () => number,
    private cooldownMs = 60_000,
  ) {}

  /** 当前阈值 */
  get threshold(): number {
    return this.thresholdMs()
  }

  /** 由 db.ts 包装层调用：监控一次语句执行，返回值透传 */
  track<T>(sql: string, params: unknown[], dbRun: () => T): T {
    const start = performance.now()
    const result = dbRun()
    const durationMs = performance.now() - start
    if (durationMs >= this.thresholdMs()) {
      this.record(sql, params, durationMs)
    }
    return result
  }

  private record(sql: string, params: unknown[], durationMs: number) {
    const now = new Date().toISOString()
    const r: Omit<SlowQueryRecord, "id"> = {
      at: now,
      sql,
      params: truncateParams(params),
      durationMs: Math.round(durationMs * 10) / 10,
    }
    /** 持久化 + 内存环形缓冲 */
    try {
      const id = this.db.runSlowQueryLog(r)
      this.records.push({ ...r, id })
      if (this.records.length > MAX_MEMORY_RECORDS) this.records.shift()
    } catch (err) {
      console.error("[slow-query] Failed to persist record:", err)
    }

    /** 聚合统计 */
    const a = this.agg.get(sql) ?? { count: 0, maxMs: 0, lastAt: now }
    a.count++
    a.maxMs = Math.max(a.maxMs, r.durationMs)
    a.lastAt = now
    this.agg.set(sql, a)

    /** 告警：console 警示 + SSE 事件，同 SQL 冷却期内不重复 */
    const last = this.cooldown.get(sql) ?? 0
    if (Date.now() - last >= this.cooldownMs) {
      this.cooldown.set(sql, Date.now())
      console.warn(`[SLOW SQL] ${r.durationMs}ms | ${summarizeSql(sql)} | params=${r.params}`)
      for (const fn of this.listeners) {
        try {
          fn({ ...r, id: this.records[this.records.length - 1]!.id })
        } catch (err) {
          console.error("[slow-query] Listener error:", err)
        }
      }
    }
  }

  /** 内存中的最近慢查询（面板查询用，DB 为准） */
  recent(): SlowQueryRecord[] {
    return [...this.records]
  }

  /** 按 SQL 聚合的高频慢点 */
  aggregated(): { sql: string; count: number; maxMs: number; lastAt: string }[] {
    return [...this.agg.entries()]
      .map(([sql, a]) => ({ sql, ...a }))
      .sort((x, y) => y.count * y.maxMs - x.count * x.maxMs)
  }

  onSlowQuery(fn: (r: SlowQueryRecord) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 未使用的自增 id 备用（当前 id 由 DB 分配） */
  peekNextId(): number {
    return this.nextId
  }
}

/** 参数序列化 + 截断（Buffer 转 base64 摘要） */
function truncateParams(params: unknown[]): string {
  let json: string
  try {
    json = JSON.stringify(params.map(p => (p instanceof Uint8Array ? `<blob ${p.length}B>` : p)))
  } catch {
    json = "<unserializable>"
  }
  if (json.length > MAX_PARAM_JSON_LEN) json = json.slice(0, MAX_PARAM_JSON_LEN) + `…(${json.length}B)`
  return json
}

/** SQL 摘要：折叠空白 + 截断到 120 字符，仅用于 console 告警展示 */
function summarizeSql(sql: string): string {
  const s = sql.replace(/\s+/g, " ").trim()
  return s.length > 120 ? s.slice(0, 120) + "…" : s
}

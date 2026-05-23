import { Database, Statement } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { ProviderConfig, RouteRule, GatewayConfig, RequestLogEntry, TokenStats, KeyGroup, ApiKey, CurlQueryConfig } from "./types.ts"

const DEFAULT_CORS: import("./types.ts").CorsConfig = {
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
}

const DEFAULT_CONFIG: GatewayConfig = {
  port: 3827,
  logLevel: "info",
  enableRequestLog: true,
  logContentRetention: 1000,
  maxLogRows: 100000,
  authRequired: false,
  cors: DEFAULT_CORS,
}

export class GatewayDB {
  private db: Database
  private stmtCache: Map<string, Statement> = new Map()
  private closed = false

  constructor(dbPath: string) {
    /** 自动创建数据库父目录，避免 release 版本直接运行时因缺少 data/ 目录而崩溃 */
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.db.run("PRAGMA journal_mode=WAL")
    this.db.run("PRAGMA synchronous=NORMAL")
    this.db.run("PRAGMA foreign_keys = ON")
    this.db.run("PRAGMA busy_timeout = 5000")
    this.initTables()
    this.prepareStatements()
    /** 定时清理日志，避免 addLog 热路径中做概率触发 */
    setInterval(() => {
      this.pruneLogContent()
      this.pruneOldLogs()
    }, GatewayDB.PRUNE_INTERVAL_MS).unref()
  }

  private static MAX_STMT_CACHE = 100

  private stmt(sql: string): Statement {
    let s = this.stmtCache.get(sql)
    if (!s) {
      if (this.stmtCache.size >= GatewayDB.MAX_STMT_CACHE) {
        /** 淘汰最早的一半缓存条目 */
        let count = 0
        for (const key of this.stmtCache.keys()) {
          if (++count > GatewayDB.MAX_STMT_CACHE / 2) break
          this.stmtCache.delete(key)
        }
      }
      s = this.db.prepare(sql)
      this.stmtCache.set(sql, s)
    }
    return s
  }

  /** 在事务中执行读后写操作，防止并发更新丢失数据 */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  private initTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
        models TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        custom_headers TEXT DEFAULT '{}',
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS route_rules (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_mapping TEXT DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 0
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        target_model TEXT NOT NULL,
        stream INTEGER NOT NULL DEFAULT 0,
        status_code INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        error TEXT
      )
    `)

    /** 复合索引：加速时间范围 + 服务商的聚合查询 */
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_logs_ts_provider ON request_logs(timestamp, provider_id)
    `)

    /** 兼容已有数据库：添加新列 */
    try {
      this.db.run("ALTER TABLE route_rules ADD COLUMN content_match TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE route_rules ADD COLUMN target_model TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE route_rules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE route_rules ADD COLUMN exclude_match TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE providers ADD COLUMN max_concurrency INTEGER DEFAULT 0")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE providers ADD COLUMN request_timeout INTEGER DEFAULT 0")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE request_logs ADD COLUMN input_content TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE request_logs ADD COLUMN output_content TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE request_logs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0")
    } catch {
      // 列已存在
    }

    /** API Key 分组表 */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS key_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        daily_token_limit INTEGER DEFAULT 0,
        monthly_token_limit INTEGER DEFAULT 0,
        rpm_limit INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    /** API Keys 表 */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        group_id TEXT NOT NULL REFERENCES key_groups(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1,
        daily_token_limit INTEGER DEFAULT 0,
        monthly_token_limit INTEGER DEFAULT 0,
        rpm_limit INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        description TEXT DEFAULT ''
      )
    `)

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_api_keys_group_id ON api_keys(group_id)`)

    /** 兼容已有数据库：api_keys 添加 key_secret 列 */
    try {
      this.db.run("ALTER TABLE api_keys ADD COLUMN key_secret TEXT DEFAULT ''")
    } catch { /* 列已存在 */ }

    /** 兼容已有数据库：添加新列 */
    try {
      this.db.run("ALTER TABLE route_rules ADD COLUMN key_groups TEXT DEFAULT NULL")
    } catch { /* 列已存在 */ }
    try {
      this.db.run("ALTER TABLE route_rules ADD COLUMN fallbacks TEXT DEFAULT NULL")
    } catch { /* 列已存在 */ }
    try {
      this.db.run("ALTER TABLE request_logs ADD COLUMN api_key_id TEXT DEFAULT NULL")
    } catch { /* 列已存在 */ }
    try {
      this.db.run("ALTER TABLE request_logs ADD COLUMN group_id TEXT DEFAULT NULL")
    } catch { /* 列已存在 */ }

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_provider_id ON request_logs(provider_id)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_status_code ON request_logs(status_code)`)
    try {
      this.db.run("ALTER TABLE request_logs ADD COLUMN fallback_attempts TEXT DEFAULT NULL")
    } catch { /* 列已存在 */ }
    /** 复合索引：加速配额查询中的时间范围 + 密钥/分组条件 */
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_ts_apikey ON request_logs(timestamp, api_key_id)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_ts_group ON request_logs(timestamp, group_id)`)
    /** 配额查询专用复合索引（以 api_key_id 为前缀，支持 WHERE api_key_id = ? AND timestamp >= ? 高效查找） */
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_apikey_ts ON request_logs(api_key_id, timestamp)`)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_group_ts ON request_logs(group_id, timestamp)`)
    /** 覆盖索引：加速 percentile 查询的 timestamp 过滤 + duration_ms 排序 */
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_ts_duration ON request_logs(timestamp, duration_ms)`)
    /** 覆盖索引：加速带 api_key_id 过滤的 percentile 查询 */
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_apikey_ts_dur ON request_logs(api_key_id, timestamp, duration_ms)`)
    /** 覆盖索引：加速带 group_id 过滤的 percentile 查询 */
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_group_ts_dur ON request_logs(group_id, timestamp, duration_ms)`)
    /** 复合索引：加速按状态码筛选 + id 排序的日志查询 */
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_logs_status_id ON request_logs(status_code, id)`)
    /** 索引：加速按 provider_id 查找路由规则（级联删除） */
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_route_rules_provider_id ON route_rules(provider_id)`)

    /** cURL 查询配置表：存储用户导入的网页端接口配置 */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS curl_queries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'GET',
        headers TEXT NOT NULL DEFAULT '{}',
        body TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
  }

  private prepareStatements() {
    // 预热常用语句
    this.stmt("SELECT value FROM config WHERE key = ?")
    this.stmt("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)")
  }

  // ========== Config ==========

  getConfig(): GatewayConfig {
    const row = this.stmt("SELECT value FROM config WHERE key = 'gateway'").get() as { value: string } | null
    if (!row) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(row.value)
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      cors: parsed.cors ? { ...DEFAULT_CORS, ...parsed.cors } : DEFAULT_CORS,
    }
  }

  saveConfig(config: GatewayConfig) {
    this.stmt("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run("gateway", JSON.stringify(config))
  }

  // ========== Providers ==========

  getProviders(): ProviderConfig[] {
    const rows = this.stmt("SELECT * FROM providers ORDER BY sort_order").all() as Record<string, unknown>[]
    return rows.map(this.rowToProvider)
  }

  getProvider(id: string): ProviderConfig | null {
    const row = this.stmt("SELECT * FROM providers WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? this.rowToProvider(row) : null
  }

  addProvider(provider: ProviderConfig) {
    this.stmt(
      "INSERT INTO providers (id, name, type, base_url, api_key, models, enabled, custom_headers, sort_order, max_concurrency, request_timeout) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      provider.id,
      provider.name,
      provider.type,
      provider.baseUrl,
      provider.apiKey,
      JSON.stringify(provider.models),
      provider.enabled ? 1 : 0,
      JSON.stringify(provider.customHeaders ?? {}),
      0,
      provider.maxConcurrency ?? 0,
      provider.requestTimeout ?? 0,
    )
  }

  updateProvider(id: string, provider: Partial<ProviderConfig>) {
    this.tx(() => {
      const existing = this.getProvider(id)
      if (!existing) return

      const updated = { ...existing, ...provider, id }
      this.stmt(
        "UPDATE providers SET name=?, type=?, base_url=?, api_key=?, models=?, enabled=?, custom_headers=?, max_concurrency=?, request_timeout=? WHERE id=?"
      ).run(
        updated.name,
        updated.type,
        updated.baseUrl,
        updated.apiKey,
        JSON.stringify(updated.models),
        updated.enabled ? 1 : 0,
        JSON.stringify(updated.customHeaders ?? {}),
        updated.maxConcurrency ?? 0,
        updated.requestTimeout ?? 0,
        id,
      )
    })
  }

  deleteProvider(id: string) {
    this.stmt("DELETE FROM providers WHERE id = ?").run(id)
  }

  private rowToProvider(row: Record<string, unknown>): ProviderConfig {
    return {
      id: row.id as string,
      name: row.name as string,
      type: row.type as ProviderConfig["type"],
      baseUrl: row.base_url as string,
      apiKey: row.api_key as string,
      models: JSON.parse(row.models as string),
      enabled: (row.enabled as number) === 1,
      customHeaders: JSON.parse((row.custom_headers as string) || "{}"),
      maxConcurrency: (row.max_concurrency as number) || undefined,
      requestTimeout: (row.request_timeout as number) || undefined,
    }
  }

  // ========== Route Rules ==========

  getRouteRules(): RouteRule[] {
    const rows = this.stmt("SELECT * FROM route_rules ORDER BY priority DESC").all() as Record<string, unknown>[]
    return rows.map(this.rowToRouteRule)
  }

  /** 按主键查询单条路由规则 */
  getRouteRule(id: string): RouteRule | null {
    const row = this.stmt("SELECT * FROM route_rules WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? this.rowToRouteRule(row) : null
  }

  addRouteRule(rule: RouteRule) {
    this.stmt(
      "INSERT INTO route_rules (id, pattern, provider_id, model_mapping, priority, content_match, target_model, enabled, exclude_match, key_groups, fallbacks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(rule.id, rule.pattern, rule.providerId, JSON.stringify(rule.modelMapping ?? {}), rule.priority, rule.contentMatch ? JSON.stringify(rule.contentMatch) : null, rule.targetModel ?? null, rule.enabled !== false ? 1 : 0, rule.excludeMatch ? JSON.stringify(rule.excludeMatch) : null, rule.keyGroups ? JSON.stringify(rule.keyGroups) : null, rule.fallbacks ? JSON.stringify(rule.fallbacks) : null)
  }

  updateRouteRule(id: string, rule: Partial<RouteRule>): boolean {
    return this.tx(() => {
      const existing = this.getRouteRule(id)
      if (!existing) return false

      const updated = { ...existing, ...rule, id }
      this.stmt(
        "UPDATE route_rules SET pattern=?, provider_id=?, model_mapping=?, priority=?, content_match=?, target_model=?, enabled=?, exclude_match=?, key_groups=?, fallbacks=? WHERE id=?"
      ).run(updated.pattern, updated.providerId, JSON.stringify(updated.modelMapping ?? {}), updated.priority, updated.contentMatch ? JSON.stringify(updated.contentMatch) : null, updated.targetModel ?? null, updated.enabled !== false ? 1 : 0, updated.excludeMatch ? JSON.stringify(updated.excludeMatch) : null, updated.keyGroups ? JSON.stringify(updated.keyGroups) : null, updated.fallbacks ? JSON.stringify(updated.fallbacks) : null, id)
      return true
    })
  }

  deleteRouteRule(id: string) {
    this.stmt("DELETE FROM route_rules WHERE id = ?").run(id)
  }

  private rowToRouteRule(row: Record<string, unknown>): RouteRule {
    return {
      id: row.id as string,
      pattern: row.pattern as string,
      providerId: row.provider_id as string,
      modelMapping: JSON.parse((row.model_mapping as string) || "{}"),
      priority: row.priority as number,
      contentMatch: row.content_match ? JSON.parse(row.content_match as string) : undefined,
      targetModel: (row.target_model as string) || undefined,
      excludeMatch: row.exclude_match ? JSON.parse(row.exclude_match as string) : undefined,
      enabled: row.enabled !== 0,
      keyGroups: row.key_groups ? JSON.parse(row.key_groups as string) : undefined,
      fallbacks: row.fallbacks ? JSON.parse(row.fallbacks as string) : undefined,
    }
  }

  // ========== Request Logs ==========

  /** 日志清理间隔 */
  private static PRUNE_INTERVAL_MS = 60_000

  addLog(log: Omit<RequestLogEntry, "id" | "timestamp">) {
    /** DB 已关闭（优雅关机期间流式请求可能仍在写入日志） */
    if (this.closed) return
    /** 裁剪过长的日志内容，避免单条记录过大 */
    const MAX_CONTENT_LEN = 50000
    const inputContent = log.inputContent && log.inputContent.length > MAX_CONTENT_LEN
      ? log.inputContent.slice(0, MAX_CONTENT_LEN) + `...[truncated ${log.inputContent.length - MAX_CONTENT_LEN} chars]`
      : log.inputContent ?? null
    const outputContent = log.outputContent && log.outputContent.length > MAX_CONTENT_LEN
      ? log.outputContent.slice(0, MAX_CONTENT_LEN) + `...[truncated ${log.outputContent.length - MAX_CONTENT_LEN} chars]`
      : log.outputContent ?? null

    this.stmt(
      "INSERT INTO request_logs (method, path, model, provider_id, target_model, stream, status_code, duration_ms, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, error, input_content, output_content, api_key_id, group_id, fallback_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      log.method,
      log.path,
      log.model,
      log.providerId,
      log.targetModel,
      log.stream ? 1 : 0,
      log.statusCode,
      log.durationMs,
      log.inputTokens,
      log.outputTokens,
      log.cacheCreationTokens,
      log.cacheReadTokens,
      log.error,
      inputContent,
      outputContent,
      log.apiKeyId ?? null,
      log.groupId ?? null,
      log.fallbackAttempts ?? null,
    )
  }

  /** 清理超出保留数量的旧日志 content 字段 */
  private pruneLogContent() {
    const retention = Math.max(1, Math.floor(Number(this.getConfig().logContentRetention ?? 1000)))
    this.tx(() => {
      const row = this.stmt("SELECT id FROM request_logs ORDER BY id DESC LIMIT 1 OFFSET ?").get(retention - 1) as { id: number } | undefined
      if (row) {
        this.stmt("UPDATE request_logs SET input_content = NULL, output_content = NULL WHERE id <= ? AND (input_content IS NOT NULL OR output_content IS NOT NULL)").run(row.id)
      }
    })
  }

  /** 删除超量旧日志行，保留最近 maxLogRows 条 */
  private pruneOldLogs() {
    const maxRows = Math.max(1000, this.getConfig().maxLogRows ?? 100000)
    this.tx(() => {
      const row = this.stmt("SELECT id FROM request_logs ORDER BY id DESC LIMIT 1 OFFSET ?").get(maxRows - 1) as { id: number } | undefined
      if (row) {
        this.stmt("DELETE FROM request_logs WHERE id <= ?").run(row.id)
      }
    })
  }

  getLogs(options: { limit?: number; offset?: number; model?: string; providerId?: string; apiKeyId?: string; groupId?: string; status?: string; sort?: string; startTime?: string; endTime?: string; hasFallback?: boolean } = {}): RequestLogEntry[] {
    const { limit = 100, offset = 0, model, providerId, apiKeyId, groupId, status, sort, startTime, endTime, hasFallback } = options

    /** 列表查询排除大字段 input_content/output_content，按需通过 getLogDetail 加载 */
    let sql = "SELECT id, timestamp, method, path, model, provider_id, target_model, stream, status_code, duration_ms, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, error, api_key_id, group_id, fallback_attempts FROM request_logs WHERE 1=1"
    const params: (string | number)[] = []

    if (model) {
      const escaped = `%${model.replace(/[%_\\]/g, "\\$&")}%`
      sql += " AND (model LIKE ? ESCAPE '\\' OR target_model LIKE ? ESCAPE '\\')"
      params.push(escaped, escaped)
    }
    if (providerId) {
      sql += " AND provider_id = ?"
      params.push(providerId)
    }
    if (apiKeyId) {
      sql += " AND api_key_id = ?"
      params.push(apiKeyId)
    }
    if (groupId) {
      sql += " AND group_id = ?"
      params.push(groupId)
    }
    if (status) {
      if (status === "error") {
        sql += " AND status_code >= ?"
        params.push(400)
      } else {
        const base = parseInt(status, 10)
        if (Number.isNaN(base)) return []
        sql += " AND status_code >= ? AND status_code < ?"
        params.push(base * 100, base * 100 + 100)
      }
    }
    if (startTime) {
      sql += " AND timestamp >= ?"
      params.push(startTime)
    }
    if (endTime) {
      sql += " AND timestamp < ?"
      params.push(endTime)
    }
    if (hasFallback) {
      sql += " AND fallback_attempts IS NOT NULL"
    }

    /** 排序：白名单列名 + 方向，防止 SQL 注入 */
    const orderBy = SORT_MAP[sort ?? ""] ?? "id DESC"
    sql += ` ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    params.push(limit, offset)

    const stmt = this.stmt(sql)
    const rows = params.length > 0 ? stmt.all(...params) : stmt.all()
    return (rows as Record<string, unknown>[]).map(this.rowToLog)
  }

  /** 获取单条日志详情（包含 input_content/output_content） */
  getLogDetail(id: number): RequestLogEntry | null {
    const row = this.stmt("SELECT * FROM request_logs WHERE id = ?").get(id) as Record<string, unknown> | undefined
    return row ? this.rowToLog(row) : null
  }

  getLogStats(filters?: { apiKeyId?: string; groupId?: string; skipTotal?: boolean }): { total: number; today: number; todayErrors: number; todayAvgMs: number; todayP50Ms: number; todayP95Ms: number; todayP99Ms: number } {
    const conditions: string[] = []
    const params: (string | number)[] = []
    if (filters?.apiKeyId) { conditions.push("api_key_id = ?"); params.push(filters.apiKeyId) }
    if (filters?.groupId) { conditions.push("group_id = ?"); params.push(filters.groupId) }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

    const total = filters?.skipTotal ? 0 : (this.stmt(`SELECT COUNT(*) as count FROM request_logs ${where}`).get(...params) as { count: number }).count
    const todayRow = this.stmt(`
      SELECT COUNT(*) as count,
             SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as errors,
             AVG(duration_ms) as avg_ms
      FROM request_logs WHERE timestamp >= ? AND timestamp < ?${conditions.length ? ` AND ${conditions.join(" AND ")}` : ""}
    `).get(todayStart(), tomorrowStart(), ...params) as { count: number; errors: number; avg_ms: number | null }

    /** 利用 SQL LIMIT+OFFSET 直接定位百分位行，避免全量加载排序 */
    const p = sqlPercentile(
      (sql) => this.stmt(sql),
      `SELECT duration_ms FROM request_logs WHERE timestamp >= ? AND timestamp < ?${conditions.length ? ` AND ${conditions.join(" AND ")}` : ""} ORDER BY duration_ms`,
      todayRow.count, [...params, todayStart(), tomorrowStart()],
    )

    return { total, today: todayRow.count, todayErrors: todayRow.errors ?? 0, todayAvgMs: Math.round(todayRow.avg_ms ?? 0), todayP50Ms: p.p50, todayP95Ms: p.p95, todayP99Ms: p.p99 }
  }

  /** 按服务商统计请求数 */
  getLogStatsByProvider(): { providerId: string; providerName: string; total: number; today: number }[] {
    const sql = `
      SELECT p.id AS provider_id, COALESCE(p.name, l.provider_id) AS provider_name,
             COUNT(*) AS total,
             SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN 1 ELSE 0 END) AS today
      FROM request_logs l
      LEFT JOIN providers p ON l.provider_id = p.id
      GROUP BY l.provider_id
      ORDER BY total DESC
    `
    return (this.stmt(sql).all(todayStart(), tomorrowStart()) as Record<string, unknown>[]).map(r => ({
      providerId: r.provider_id as string,
      providerName: r.provider_name as string,
      total: r.total as number,
      today: r.today as number,
    }))
  }

  /** 按模型统计请求数 */
  getLogStatsByModel(): { model: string; targetModel: string; total: number; today: number }[] {
    const sql = `
      SELECT model, target_model AS targetModel,
             COUNT(*) AS total,
             SUM(CASE WHEN timestamp >= ? AND timestamp < ? THEN 1 ELSE 0 END) AS today
      FROM request_logs
      GROUP BY model, target_model
      ORDER BY total DESC
    `
    return (this.stmt(sql).all(todayStart(), tomorrowStart()) as Record<string, unknown>[]).map(r => ({
      model: r.model as string,
      targetModel: r.targetModel as string,
      total: r.total as number,
      today: r.today as number,
    }))
  }

  private rowToLog(row: Record<string, unknown>): RequestLogEntry {
    return {
      id: row.id as number,
      timestamp: row.timestamp as string,
      method: row.method as string,
      path: row.path as string,
      model: row.model as string,
      providerId: row.provider_id as string,
      targetModel: row.target_model as string,
      stream: (row.stream as number) === 1,
      statusCode: row.status_code as number,
      durationMs: row.duration_ms as number,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      cacheCreationTokens: (row.cache_creation_tokens as number) || 0,
      cacheReadTokens: (row.cache_read_tokens as number) || 0,
      error: row.error as string | null,
      inputContent: (row.input_content as string) || null,
      outputContent: (row.output_content as string) || null,
      apiKeyId: (row.api_key_id as string) || null,
      groupId: (row.group_id as string) || null,
      fallbackAttempts: (row.fallback_attempts as string) || null,
    }
  }

  // ========== Token 统计 ==========

  /** Token 用量汇总（总量 + 今日），skipTotal 时跳过全表 SUM */
  getTokenStats(skipTotal?: boolean): { total: TokenStats; today: TokenStats } {
    const sql = `SELECT
      COALESCE(SUM(input_tokens), 0) as inputTokens,
      COALESCE(SUM(output_tokens), 0) as outputTokens,
      COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
      COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens
    FROM request_logs WHERE `
    const total = skipTotal ? { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } : this.stmt(sql + "1=1").get() as TokenStats
    const today = this.stmt(sql + "timestamp >= ? AND timestamp < ?").get(todayStart(), tomorrowStart()) as TokenStats
    return { total, today }
  }

  /** 按服务商统计 token 用量（总量 + 今日） */
  getTokenStatsByProvider(): { providerId: string; providerName: string; total: TokenStats; today: TokenStats }[] {
    const sql = `
      SELECT p.id AS providerId, COALESCE(p.name, l.provider_id) AS providerName,
             COALESCE(SUM(l.input_tokens), 0) AS "total.inputTokens",
             COALESCE(SUM(l.output_tokens), 0) AS "total.outputTokens",
             COALESCE(SUM(l.cache_creation_tokens), 0) AS "total.cacheCreationTokens",
             COALESCE(SUM(l.cache_read_tokens), 0) AS "total.cacheReadTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.input_tokens END), 0) AS "today.inputTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.output_tokens END), 0) AS "today.outputTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.cache_creation_tokens END), 0) AS "today.cacheCreationTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.cache_read_tokens END), 0) AS "today.cacheReadTokens"
      FROM request_logs l
      LEFT JOIN providers p ON l.provider_id = p.id
      GROUP BY l.provider_id
      ORDER BY "total.inputTokens" + "total.outputTokens" DESC
    `
    const ts = todayStart(), te = tomorrowStart()
    const rows = this.stmt(sql).all(ts, te, ts, te, ts, te, ts, te) as Record<string, string | number>[]
    return rows.map(r => ({
      providerId: r.providerId as string,
      providerName: r.providerName as string,
      total: { inputTokens: r["total.inputTokens"] as number, outputTokens: r["total.outputTokens"] as number, cacheCreationTokens: r["total.cacheCreationTokens"] as number, cacheReadTokens: r["total.cacheReadTokens"] as number },
      today: { inputTokens: r["today.inputTokens"] as number, outputTokens: r["today.outputTokens"] as number, cacheCreationTokens: r["today.cacheCreationTokens"] as number, cacheReadTokens: r["today.cacheReadTokens"] as number },
    }))
  }

  /** 按模型统计 token 用量（总量 + 今日） */
  getTokenStatsByModel(): { model: string; targetModel: string; total: TokenStats; today: TokenStats }[] {
    const sql = `
      SELECT model, target_model AS targetModel,
             COALESCE(SUM(input_tokens), 0) AS "total.inputTokens",
             COALESCE(SUM(output_tokens), 0) AS "total.outputTokens",
             COALESCE(SUM(cache_creation_tokens), 0) AS "total.cacheCreationTokens",
             COALESCE(SUM(cache_read_tokens), 0) AS "total.cacheReadTokens",
             COALESCE(SUM(CASE WHEN timestamp >= ? AND timestamp < ? THEN input_tokens END), 0) AS "today.inputTokens",
             COALESCE(SUM(CASE WHEN timestamp >= ? AND timestamp < ? THEN output_tokens END), 0) AS "today.outputTokens",
             COALESCE(SUM(CASE WHEN timestamp >= ? AND timestamp < ? THEN cache_creation_tokens END), 0) AS "today.cacheCreationTokens",
             COALESCE(SUM(CASE WHEN timestamp >= ? AND timestamp < ? THEN cache_read_tokens END), 0) AS "today.cacheReadTokens"
      FROM request_logs
      GROUP BY model, target_model
      ORDER BY "total.inputTokens" + "total.outputTokens" DESC
    `
    const ts = todayStart(), te = tomorrowStart()
    const rows = this.stmt(sql).all(ts, te, ts, te, ts, te, ts, te) as Record<string, string | number>[]
    return rows.map(r => ({
      model: r.model as string,
      targetModel: r.targetModel as string,
      total: { inputTokens: r["total.inputTokens"] as number, outputTokens: r["total.outputTokens"] as number, cacheCreationTokens: r["total.cacheCreationTokens"] as number, cacheReadTokens: r["total.cacheReadTokens"] as number },
      today: { inputTokens: r["today.inputTokens"] as number, outputTokens: r["today.outputTokens"] as number, cacheCreationTokens: r["today.cacheCreationTokens"] as number, cacheReadTokens: r["today.cacheReadTokens"] as number },
    }))
  }

  /** 按小时统计 token 用量（用于图表） */
  getTokenStatsByHour(hours: number = 24): ({ hour: string } & TokenStats)[] {
    const clamped = Math.min(Math.max(Math.floor(hours), 1), 168)
    const cutoff = new Date(Date.now() - clamped * 3600_000).toISOString().replace("T", " ").slice(0, 19)
    const sql = `SELECT strftime('%Y-%m-%d %H:00', timestamp, 'localtime') AS hour,
             COALESCE(SUM(input_tokens), 0) AS inputTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens
      FROM request_logs
      WHERE timestamp >= ?
      GROUP BY hour
      ORDER BY hour ASC`
    return this.stmt(sql).all(cutoff) as ({ hour: string } & TokenStats)[]
  }

  // ========== Key Groups ==========

  getKeyGroups(): KeyGroup[] {
    const rows = this.stmt("SELECT * FROM key_groups ORDER BY created_at").all() as Record<string, unknown>[]
    return rows.map(this.rowToKeyGroup)
  }

  getKeyGroup(id: string): KeyGroup | null {
    const row = this.stmt("SELECT * FROM key_groups WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? this.rowToKeyGroup(row) : null
  }

  getKeyGroupByName(name: string): KeyGroup | null {
    const row = this.stmt("SELECT * FROM key_groups WHERE name = ?").get(name) as Record<string, unknown> | null
    return row ? this.rowToKeyGroup(row) : null
  }

  addKeyGroup(group: KeyGroup) {
    this.stmt(
      "INSERT INTO key_groups (id, name, description, daily_token_limit, monthly_token_limit, rpm_limit) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(group.id, group.name, group.description, group.dailyTokenLimit, group.monthlyTokenLimit, group.rpmLimit)
  }

  updateKeyGroup(id: string, group: Partial<KeyGroup>) {
    this.tx(() => {
      const existing = this.getKeyGroup(id)
      if (!existing) return
      const updated = { ...existing, ...group, id }
      this.stmt(
        "UPDATE key_groups SET name=?, description=?, daily_token_limit=?, monthly_token_limit=?, rpm_limit=? WHERE id=?"
      ).run(updated.name, updated.description, updated.dailyTokenLimit, updated.monthlyTokenLimit, updated.rpmLimit, id)
    })
  }

  deleteKeyGroup(id: string) {
    this.stmt("DELETE FROM key_groups WHERE id = ?").run(id)
  }

  private rowToKeyGroup(row: Record<string, unknown>): KeyGroup {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) || "",
      dailyTokenLimit: (row.daily_token_limit as number) || 0,
      monthlyTokenLimit: (row.monthly_token_limit as number) || 0,
      rpmLimit: (row.rpm_limit as number) || 0,
      createdAt: row.created_at as string,
    }
  }

  // ========== API Keys ==========

  getApiKeys(): ApiKey[] {
    const rows = this.stmt("SELECT * FROM api_keys ORDER BY created_at").all() as Record<string, unknown>[]
    return rows.map(this.rowToApiKey)
  }

  getApiKey(id: string): ApiKey | null {
    const row = this.stmt("SELECT * FROM api_keys WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? this.rowToApiKey(row) : null
  }

  getApiKeyByHash(hash: string): ApiKey | null {
    const row = this.stmt("SELECT * FROM api_keys WHERE key_hash = ?").get(hash) as Record<string, unknown> | null
    return row ? this.rowToApiKey(row) : null
  }

  addApiKey(key: ApiKey) {
    this.stmt(
      "INSERT INTO api_keys (id, name, key_hash, key_prefix, key_secret, group_id, enabled, daily_token_limit, monthly_token_limit, rpm_limit, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(key.id, key.name, key.keyHash, key.keyPrefix, key.keySecret, key.groupId, key.enabled ? 1 : 0, key.dailyTokenLimit, key.monthlyTokenLimit, key.rpmLimit, key.description)
  }

  updateApiKey(id: string, key: Partial<ApiKey>) {
    this.tx(() => {
      const existing = this.getApiKey(id)
      if (!existing) return
      const updated = { ...existing, ...key, id }
      this.stmt(
        "UPDATE api_keys SET name=?, key_hash=?, key_prefix=?, key_secret=?, group_id=?, enabled=?, daily_token_limit=?, monthly_token_limit=?, rpm_limit=?, description=? WHERE id=?"
      ).run(updated.name, updated.keyHash, updated.keyPrefix, updated.keySecret, updated.groupId, updated.enabled ? 1 : 0, updated.dailyTokenLimit, updated.monthlyTokenLimit, updated.rpmLimit, updated.description, id)
    })
  }

  deleteApiKey(id: string) {
    this.stmt("DELETE FROM api_keys WHERE id = ?").run(id)
  }

  updateKeyLastUsed(id: string) {
    this.stmt("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(id)
  }

  /** 该分组下的 Key 数量 */
  getKeyCountByGroup(groupId: string): number {
    return (this.stmt("SELECT COUNT(*) as count FROM api_keys WHERE group_id = ?").get(groupId) as { count: number }).count
  }

  /** 获取所有分组及其 Key 数量（单次 JOIN 查询，替代 N+1） */
  getKeyGroupsWithCount(): (KeyGroup & { keyCount: number })[] {
    const rows = this.stmt(`
      SELECT kg.*, COUNT(ak.id) AS key_count
      FROM key_groups kg
      LEFT JOIN api_keys ak ON ak.group_id = kg.id
      GROUP BY kg.id
      ORDER BY kg.created_at
    `).all() as Record<string, unknown>[]
    return rows.map(r => ({
      ...this.rowToKeyGroup(r),
      keyCount: r.key_count as number,
    }))
  }

  private rowToApiKey(row: Record<string, unknown>): ApiKey {
    return {
      id: row.id as string,
      name: row.name as string,
      keyHash: row.key_hash as string,
      keyPrefix: row.key_prefix as string,
      keySecret: (row.key_secret as string) || "",
      groupId: row.group_id as string,
      enabled: (row.enabled as number) === 1,
      dailyTokenLimit: (row.daily_token_limit as number) || 0,
      monthlyTokenLimit: (row.monthly_token_limit as number) || 0,
      rpmLimit: (row.rpm_limit as number) || 0,
      createdAt: row.created_at as string,
      lastUsedAt: (row.last_used_at as string) || null,
      description: (row.description as string) || "",
    }
  }

  // ========== 按密钥/分组统计 ==========

  /** 按密钥分组统计 Token 用量（总量 + 今日） */
  getTokenStatsByGroup(): { groupId: string; groupName: string; total: TokenStats; today: TokenStats }[] {
    const sql = `
      SELECT kg.id AS groupId, kg.name AS groupName,
             COALESCE(SUM(l.input_tokens), 0) AS "total.inputTokens",
             COALESCE(SUM(l.output_tokens), 0) AS "total.outputTokens",
             COALESCE(SUM(l.cache_creation_tokens), 0) AS "total.cacheCreationTokens",
             COALESCE(SUM(l.cache_read_tokens), 0) AS "total.cacheReadTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.input_tokens END), 0) AS "today.inputTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.output_tokens END), 0) AS "today.outputTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.cache_creation_tokens END), 0) AS "today.cacheCreationTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.cache_read_tokens END), 0) AS "today.cacheReadTokens"
      FROM request_logs l
      JOIN api_keys ak ON l.api_key_id = ak.id
      JOIN key_groups kg ON ak.group_id = kg.id
      WHERE l.api_key_id IS NOT NULL
      GROUP BY kg.id
      ORDER BY "total.inputTokens" + "total.outputTokens" DESC
    `
    const ts = todayStart(), te = tomorrowStart()
    const rows = this.stmt(sql).all(ts, te, ts, te, ts, te, ts, te) as Record<string, string | number>[]
    return rows.map(r => ({
      groupId: r.groupId as string,
      groupName: r.groupName as string,
      total: { inputTokens: r["total.inputTokens"] as number, outputTokens: r["total.outputTokens"] as number, cacheCreationTokens: r["total.cacheCreationTokens"] as number, cacheReadTokens: r["total.cacheReadTokens"] as number },
      today: { inputTokens: r["today.inputTokens"] as number, outputTokens: r["today.outputTokens"] as number, cacheCreationTokens: r["today.cacheCreationTokens"] as number, cacheReadTokens: r["today.cacheReadTokens"] as number },
    }))
  }

  /** 按密钥统计 Token 用量（总量 + 今日） */
  getTokenStatsByKey(): { keyId: string; keyName: string; groupId: string; groupName: string; total: TokenStats; today: TokenStats }[] {
    const sql = `
      SELECT ak.id AS keyId, ak.name AS keyName, ak.group_id AS groupId, COALESCE(kg.name, ak.group_id) AS groupName,
             COALESCE(SUM(l.input_tokens), 0) AS "total.inputTokens",
             COALESCE(SUM(l.output_tokens), 0) AS "total.outputTokens",
             COALESCE(SUM(l.cache_creation_tokens), 0) AS "total.cacheCreationTokens",
             COALESCE(SUM(l.cache_read_tokens), 0) AS "total.cacheReadTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.input_tokens END), 0) AS "today.inputTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.output_tokens END), 0) AS "today.outputTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.cache_creation_tokens END), 0) AS "today.cacheCreationTokens",
             COALESCE(SUM(CASE WHEN l.timestamp >= ? AND l.timestamp < ? THEN l.cache_read_tokens END), 0) AS "today.cacheReadTokens"
      FROM request_logs l
      JOIN api_keys ak ON l.api_key_id = ak.id
      LEFT JOIN key_groups kg ON ak.group_id = kg.id
      WHERE l.api_key_id IS NOT NULL
      GROUP BY ak.id
      ORDER BY "total.inputTokens" + "total.outputTokens" DESC
    `
    const ts = todayStart(), te = tomorrowStart()
    const rows = this.stmt(sql).all(ts, te, ts, te, ts, te, ts, te) as Record<string, string | number>[]
    return rows.map(r => ({
      keyId: r.keyId as string,
      keyName: r.keyName as string,
      groupId: r.groupId as string,
      groupName: r.groupName as string,
      total: { inputTokens: r["total.inputTokens"] as number, outputTokens: r["total.outputTokens"] as number, cacheCreationTokens: r["total.cacheCreationTokens"] as number, cacheReadTokens: r["total.cacheReadTokens"] as number },
      today: { inputTokens: r["today.inputTokens"] as number, outputTokens: r["today.outputTokens"] as number, cacheCreationTokens: r["today.cacheCreationTokens"] as number, cacheReadTokens: r["today.cacheReadTokens"] as number },
    }))
  }

  /** 获取指定 Key 今日已用 Token（使用索引友好的范围比较） */
  getDailyKeyUsage(keyId: string): number {
    const row = this.stmt(
      "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM request_logs WHERE api_key_id = ? AND timestamp >= ? AND timestamp < ?"
    ).get(keyId, todayStart(), tomorrowStart()) as { total: number }
    return row.total
  }

  /** 获取指定 Key 本月已用 Token（使用索引友好的范围比较） */
  getMonthlyKeyUsage(keyId: string): number {
    const row = this.stmt(
      "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM request_logs WHERE api_key_id = ? AND timestamp >= ? AND timestamp < ?"
    ).get(keyId, monthStart(), nextMonthStart()) as { total: number }
    return row.total
  }

  // ========== cURL 查询配置 ==========

  getCurlQueries(): CurlQueryConfig[] {
    const rows = this.stmt("SELECT * FROM curl_queries ORDER BY created_at").all() as Record<string, unknown>[]
    return rows.map(this.rowToCurlQuery)
  }

  getCurlQuery(id: string): CurlQueryConfig | null {
    const row = this.stmt("SELECT * FROM curl_queries WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? this.rowToCurlQuery(row) : null
  }

  addCurlQuery(config: CurlQueryConfig) {
    this.stmt(
      "INSERT INTO curl_queries (id, name, url, method, headers, body) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(config.id, config.name, config.url, config.method, JSON.stringify(config.headers), config.body ?? null)
  }

  updateCurlQuery(id: string, config: Partial<CurlQueryConfig>) {
    this.tx(() => {
      const existing = this.getCurlQuery(id)
      if (!existing) return
      const updated = { ...existing, ...config, id }
      this.stmt(
        "UPDATE curl_queries SET name=?, url=?, method=?, headers=?, body=? WHERE id=?"
      ).run(updated.name, updated.url, updated.method, JSON.stringify(updated.headers), updated.body ?? null, id)
    })
  }

  deleteCurlQuery(id: string) {
    this.stmt("DELETE FROM curl_queries WHERE id = ?").run(id)
  }

  private rowToCurlQuery(row: Record<string, unknown>): CurlQueryConfig {
    return {
      id: row.id as string,
      name: row.name as string,
      url: row.url as string,
      method: row.method as string,
      headers: JSON.parse((row.headers as string) || "{}"),
      body: (row.body as string) || undefined,
    }
  }

  // ========== 按时间范围统计 Token（用于用量面板） ==========

  /** 获取指定 provider 在指定时间范围内的 token 用量 */
  getTokenStatsByProviderAndTimeRange(providerId: string, start: string, end: string): TokenStats {
    const row = this.stmt(
      `SELECT
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
        COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens
      FROM request_logs WHERE provider_id = ? AND timestamp >= ? AND timestamp < ?`
    ).get(providerId, start, end) as TokenStats
    return row
  }

  close() {
    this.closed = true
    this.db.close()
  }
}

/** 日志排序白名单：前端传入的 sort 参数 -> SQL ORDER BY 子句 */
const SORT_MAP: Record<string, string> = {
  duration_desc: "duration_ms DESC",
  duration_asc: "duration_ms ASC",
  status_desc: "status_code DESC",
  status_asc: "status_code ASC",
  time_desc: "id DESC",
  time_asc: "id ASC",
}

/**
 * 利用 SQL LIMIT+OFFSET 直接定位百分位行，避免全量加载到内存。
 * stmtFn 用于获取 prepared statement。
 */
function sqlPercentile(
  stmtFn: (sql: string) => Statement,
  baseSql: string, totalCount: number, baseParams: (string | number)[],
): { p50: number; p95: number; p99: number } {
  if (totalCount === 0) return { p50: 0, p95: 0, p99: 0 }
  const query = (offset: number) =>
    (stmtFn(`${baseSql} LIMIT 1 OFFSET ?`).get(...baseParams, offset) as { duration_ms: number } | null)?.duration_ms ?? 0

  const p50Off = Math.min(Math.floor(0.5 * totalCount), totalCount - 1)
  const p95Off = Math.min(Math.floor(0.95 * totalCount), totalCount - 1)
  const p99Off = Math.min(Math.floor(0.99 * totalCount), totalCount - 1)

  const p50 = query(p50Off)
  const p95 = p95Off === p50Off ? p50 : query(p95Off)
  const p99 = p99Off === p95Off ? p95 : query(p99Off)
  return { p50, p95, p99 }
}

/** UTC 时间边界，与 DEFAULT (datetime('now')) 保持一致 */
function todayStart(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} 00:00:00`
}

function tomorrowStart(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} 00:00:00`
}

function monthStart(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01 00:00:00`
}

function nextMonthStart(): string {
  const d = new Date()
  d.setUTCMonth(d.getUTCMonth() + 1)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01 00:00:00`
}

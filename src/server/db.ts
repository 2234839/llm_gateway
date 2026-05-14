import { Database, Statement } from "bun:sqlite"
import type { ProviderConfig, RouteRule, GatewayConfig, RequestLogEntry, TokenStats } from "./types.ts"

const DEFAULT_CONFIG: GatewayConfig = {
  port: 3827,
  logLevel: "info",
  enableRequestLog: true,
  logContentRetention: 1000,
}

export class GatewayDB {
  private db: Database
  private stmtCache: Map<string, Statement> = new Map()

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode=WAL")
    this.db.exec("PRAGMA synchronous=NORMAL")
    this.initTables()
    this.prepareStatements()
  }

  private stmt(sql: string): Statement {
    let s = this.stmtCache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmtCache.set(sql, s)
    }
    return s
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)

    this.db.exec(`
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS route_rules (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_mapping TEXT DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 0
      )
    `)

    this.db.exec(`
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON request_logs(timestamp)
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(model)
    `)

    /** 兼容已有数据库：添加新列 */
    try {
      this.db.exec("ALTER TABLE route_rules ADD COLUMN content_match TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.exec("ALTER TABLE route_rules ADD COLUMN target_model TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.exec("ALTER TABLE route_rules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1")
    } catch {
      // 列已存在
    }
    try {
      this.db.exec("ALTER TABLE route_rules ADD COLUMN exclude_match TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.exec("ALTER TABLE providers ADD COLUMN max_concurrency INTEGER DEFAULT 0")
    } catch {
      // 列已存在
    }
    try {
      this.db.exec("ALTER TABLE request_logs ADD COLUMN input_content TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.exec("ALTER TABLE request_logs ADD COLUMN output_content TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.exec("ALTER TABLE request_logs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0")
    } catch {
      // 列已存在
    }
    try {
      this.db.exec("ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0")
    } catch {
      // 列已存在
    }
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
    return { ...DEFAULT_CONFIG, ...JSON.parse(row.value) }
  }

  saveConfig(config: GatewayConfig) {
    this.stmt("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run("gateway", JSON.stringify(config))
  }

  // ========== Providers ==========

  getProviders(): ProviderConfig[] {
    const rows = this.db.prepare("SELECT * FROM providers ORDER BY sort_order").all() as Record<string, unknown>[]
    return rows.map(this.rowToProvider)
  }

  getProvider(id: string): ProviderConfig | null {
    const row = this.stmt("SELECT * FROM providers WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? this.rowToProvider(row) : null
  }

  addProvider(provider: ProviderConfig) {
    this.stmt(
      "INSERT INTO providers (id, name, type, base_url, api_key, models, enabled, custom_headers, sort_order, max_concurrency) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
    )
  }

  updateProvider(id: string, provider: Partial<ProviderConfig>) {
    const existing = this.getProvider(id)
    if (!existing) return

    const updated = { ...existing, ...provider, id }
    this.stmt(
      "UPDATE providers SET name=?, type=?, base_url=?, api_key=?, models=?, enabled=?, custom_headers=?, max_concurrency=? WHERE id=?"
    ).run(
      updated.name,
      updated.type,
      updated.baseUrl,
      updated.apiKey,
      JSON.stringify(updated.models),
      updated.enabled ? 1 : 0,
      JSON.stringify(updated.customHeaders ?? {}),
      updated.maxConcurrency ?? 0,
      id,
    )
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
    }
  }

  // ========== Route Rules ==========

  getRouteRules(): RouteRule[] {
    const rows = this.db.prepare("SELECT * FROM route_rules ORDER BY priority DESC").all() as Record<string, unknown>[]
    return rows.map(this.rowToRouteRule)
  }

  addRouteRule(rule: RouteRule) {
    this.stmt(
      "INSERT INTO route_rules (id, pattern, provider_id, model_mapping, priority, content_match, target_model, enabled, exclude_match) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(rule.id, rule.pattern, rule.providerId, JSON.stringify(rule.modelMapping ?? {}), rule.priority, rule.contentMatch ? JSON.stringify(rule.contentMatch) : null, rule.targetModel ?? null, rule.enabled !== false ? 1 : 0, rule.excludeMatch ? JSON.stringify(rule.excludeMatch) : null)
  }

  updateRouteRule(id: string, rule: Partial<RouteRule>) {
    const existing = this.getRouteRules().find(r => r.id === id)
    if (!existing) return

    const updated = { ...existing, ...rule, id }
    this.stmt(
      "UPDATE route_rules SET pattern=?, provider_id=?, model_mapping=?, priority=?, content_match=?, target_model=?, enabled=?, exclude_match=? WHERE id=?"
    ).run(updated.pattern, updated.providerId, JSON.stringify(updated.modelMapping ?? {}), updated.priority, updated.contentMatch ? JSON.stringify(updated.contentMatch) : null, updated.targetModel ?? null, updated.enabled !== false ? 1 : 0, updated.excludeMatch ? JSON.stringify(updated.excludeMatch) : null, id)
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
    }
  }

  // ========== Request Logs ==========

  addLog(log: Omit<RequestLogEntry, "id" | "timestamp">) {
    this.stmt(
      "INSERT INTO request_logs (method, path, model, provider_id, target_model, stream, status_code, duration_ms, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, error, input_content, output_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
      log.inputContent ?? null,
      log.outputContent ?? null,
    )
    this.pruneLogContent()
  }

  /** 清理超出保留数量的旧日志 content 字段 */
  private pruneLogContent() {
    const retention = this.getConfig().logContentRetention ?? 1000
    this.db.exec(
      `UPDATE request_logs SET input_content = NULL, output_content = NULL WHERE id IN (SELECT id FROM request_logs WHERE input_content IS NOT NULL ORDER BY id DESC LIMIT -1 OFFSET ${retention})`
    )
  }

  getLogs(options: { limit?: number; offset?: number; model?: string; providerId?: string } = {}): RequestLogEntry[] {
    const { limit = 100, offset = 0, model, providerId } = options

    let sql = "SELECT * FROM request_logs WHERE 1=1"
    const params: (string | number)[] = []

    if (model) {
      sql += " AND model = ?"
      params.push(model)
    }
    if (providerId) {
      sql += " AND provider_id = ?"
      params.push(providerId)
    }

    sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
    params.push(limit, offset)

    const stmt = this.db.prepare(sql)
    const rows = params.length > 0 ? stmt.all(...params) : stmt.all()
    return (rows as Record<string, unknown>[]).map(this.rowToLog)
  }

  getLogStats(): { total: number; today: number } {
    const total = (this.stmt("SELECT COUNT(*) as count FROM request_logs").get() as { count: number }).count
    const today = (this.stmt("SELECT COUNT(*) as count FROM request_logs WHERE date(timestamp, 'localtime') = date('now', 'localtime')").get() as { count: number }).count
    return { total, today }
  }

  /** 按服务商统计请求数 */
  getLogStatsByProvider(): { providerId: string; providerName: string; total: number; today: number }[] {
    const sql = `
      SELECT p.id AS provider_id, COALESCE(p.name, l.provider_id) AS provider_name,
             COUNT(*) AS total,
             SUM(CASE WHEN date(l.timestamp, 'localtime') = date('now', 'localtime') THEN 1 ELSE 0 END) AS today
      FROM request_logs l
      LEFT JOIN providers p ON l.provider_id = p.id
      GROUP BY l.provider_id
      ORDER BY total DESC
    `
    return (this.db.prepare(sql).all() as Record<string, unknown>[]).map(r => ({
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
             SUM(CASE WHEN date(timestamp, 'localtime') = date('now', 'localtime') THEN 1 ELSE 0 END) AS today
      FROM request_logs
      GROUP BY model, target_model
      ORDER BY total DESC
    `
    return (this.db.prepare(sql).all() as Record<string, unknown>[]).map(r => ({
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
    }
  }

  // ========== Token 统计 ==========

  /** Token 用量汇总（总量 + 今日） */
  getTokenStats(): { total: TokenStats; today: TokenStats } {
    const querySum = (where: string): TokenStats => {
      const sql = `SELECT
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(cache_creation_tokens), 0) as cacheCreationTokens,
        COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens
      FROM request_logs WHERE ${where}`
      return this.stmt(sql).get() as TokenStats
    }
    return { total: querySum("1=1"), today: querySum("date(timestamp, 'localtime') = date('now', 'localtime')") }
  }

  /** 按服务商统计 token 用量 */
  getTokenStatsByProvider(): ({ providerId: string; providerName: string } & TokenStats)[] {
    const sql = `
      SELECT p.id AS providerId, COALESCE(p.name, l.provider_id) AS providerName,
             COALESCE(SUM(l.input_tokens), 0) AS inputTokens,
             COALESCE(SUM(l.output_tokens), 0) AS outputTokens,
             COALESCE(SUM(l.cache_creation_tokens), 0) AS cacheCreationTokens,
             COALESCE(SUM(l.cache_read_tokens), 0) AS cacheReadTokens
      FROM request_logs l
      LEFT JOIN providers p ON l.provider_id = p.id
      GROUP BY l.provider_id
      ORDER BY inputTokens + outputTokens DESC
    `
    return this.db.prepare(sql).all() as ({ providerId: string; providerName: string } & TokenStats)[]
  }

  /** 按模型统计 token 用量 */
  getTokenStatsByModel(): ({ model: string; targetModel: string } & TokenStats)[] {
    const sql = `
      SELECT model, target_model AS targetModel,
             COALESCE(SUM(input_tokens), 0) AS inputTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens
      FROM request_logs
      GROUP BY model, target_model
      ORDER BY inputTokens + outputTokens DESC
    `
    return this.db.prepare(sql).all() as ({ model: string; targetModel: string } & TokenStats)[]
  }

  /** 按小时统计 token 用量（用于图表） */
  getTokenStatsByHour(hours: number = 24): ({ hour: string } & TokenStats)[] {
    const clamped = Math.min(Math.max(hours, 1), 168)
    const sql = `SELECT strftime('%Y-%m-%d %H:00', timestamp, 'localtime') AS hour,
             COALESCE(SUM(input_tokens), 0) AS inputTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens
      FROM request_logs
      WHERE timestamp >= datetime('now', '-${clamped} hours')
      GROUP BY hour
      ORDER BY hour ASC`
    return this.db.prepare(sql).all() as ({ hour: string } & TokenStats)[]
  }

  close() {
    this.db.close()
  }
}

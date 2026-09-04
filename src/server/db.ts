import { Database, Statement } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { ProviderConfig, RouteRule, GatewayConfig, RequestLogEntry, TokenStats, KeyGroup, ApiKey, CurlQueryConfig, RewriteRule, RewriteAction, RewriteMatchCondition, LogMessage, LogImage, ConditionNode, ConditionLeaf, ConditionGroup, SecretEntry } from "./types.ts"
import { SlowQueryMonitor } from "./utils/slow-query.ts"

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
  /** 慢 SQL 监控：阈值从配置动态读取（track 时刻读，避免配置变更后需同步两份状态） */
  readonly slowQueryMonitor: SlowQueryMonitor

  constructor(dbPath: string) {
    /** 自动创建数据库父目录，避免 release 版本直接运行时因缺少 data/ 目录而崩溃 */
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath, { create: true })
    this.db.run("PRAGMA journal_mode=WAL")
    this.db.run("PRAGMA synchronous=NORMAL")
    this.db.run("PRAGMA foreign_keys = ON")
    this.db.run("PRAGMA busy_timeout = 5000")
    /** 先建表再建 monitor：monitor 持久化依赖 slow_query_log 表 */
    this.initTables()
    this.slowQueryMonitor = new SlowQueryMonitor(this, () => this.getSlowSqlThreshold())
    this.prepareStatements()
    /** 定时清理日志，避免 addLog 热路径中做概率触发 */
    setInterval(() => {
      this.pruneLogContent()
      this.pruneOldLogs()
      this.pruneSlowQueryLog()
    }, GatewayDB.PRUNE_INTERVAL_MS).unref()
  }

  /** 慢 SQL 阈值（ms）：从 gateway 配置读，默认 100，动态生效。
   *  必须绕开监控包装直读 DB：getConfig 走 stmt 包装会经 track → getSlowSqlThreshold 无限递归 */
  getSlowSqlThreshold(): number {
    try {
      const row = this.db.prepare("SELECT value FROM config WHERE key = 'gateway'").get() as { value: string } | null
      if (!row) return 100
      return (JSON.parse(row.value).slowSqlThresholdMs as number | undefined) ?? 100
    } catch {
      return 100
    }
  }

  /** 持久化一条慢查询记录，返回插入 id */
  runSlowQueryLog(r: { at: string; sql: string; params: string; durationMs: number }): number {
    const result = this.db.prepare("INSERT INTO slow_query_log (at, sql, params, duration_ms) VALUES (?, ?, ?, ?)").run(r.at, r.sql, r.params, r.durationMs)
    return Number(result.lastInsertRowid)
  }

  /** 查询慢 SQL 日志（最新的在前） */
  getSlowQueryLog(limit = 100): { id: number; at: string; sql: string; params: string; durationMs: number }[] {
    const rows = this.db.prepare("SELECT id, at, sql, params, duration_ms FROM slow_query_log ORDER BY id DESC LIMIT ?").all(limit) as Record<string, unknown>[]
    return rows.map(row => ({
      id: row.id as number,
      at: row.at as string,
      sql: row.sql as string,
      params: row.params as string,
      durationMs: row.duration_ms as number,
    }))
  }

  /** 慢 SQL 日志保留条数上限，超出删除最旧记录 */
  private pruneSlowQueryLog() {
    const retention = 500
    const row = this.db.prepare("SELECT id FROM slow_query_log ORDER BY id DESC LIMIT 1 OFFSET ?").get(retention - 1) as { id: number } | undefined
    if (row) this.db.prepare("DELETE FROM slow_query_log WHERE id <= ?").run(row.id)
  }

  private static MAX_STMT_CACHE = 100

  /** SQL -> 监控包装语句缓存（与 stmtCache 同生命周期，避免热路径重复分配包装对象） */
  private wrappedCache: Map<string, { get: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown; run: (...p: unknown[]) => unknown }> = new Map()

  private stmt(sql: string): Statement {
    const cachedWrap = this.wrappedCache.get(sql)
    if (cachedWrap) return cachedWrap as unknown as Statement
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
    const monitor = this.slowQueryMonitor
    const stmt = s!
      /** 监控包装：耗时超阈值的执行被记录 + 告警；阈值内仅多两次 performance.now() 调用 */
    const wrapped = {
      get: (...params: unknown[]) => monitor.track(sql, params, () => stmt.get(...(params as never[]))),
      all: (...params: unknown[]) => monitor.track(sql, params, () => stmt.all(...(params as never[]))),
      run: (...params: unknown[]) => monitor.track(sql, params, () => stmt.run(...(params as never[]))),
    }
    this.wrappedCache.set(sql, wrapped)
    return wrapped as unknown as Statement
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
        sort_order INTEGER NOT NULL DEFAULT 0,
        allowed_client_headers TEXT DEFAULT '[]'
      )
    `)

    this.db.run(`
      CREATE TABLE IF NOT EXISTS route_rules (
        id TEXT PRIMARY KEY,
        pattern TEXT NOT NULL,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_mapping TEXT DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 0,
        retry_qpm_limit INTEGER NOT NULL DEFAULT 0,
        retry_on_529 INTEGER NOT NULL DEFAULT 0,
        retry_all_failures INTEGER NOT NULL DEFAULT 0
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
      this.db.run("ALTER TABLE route_rules ADD COLUMN match_conditions TEXT DEFAULT NULL")
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
      this.db.run("ALTER TABLE route_rules ADD COLUMN retry_qpm_limit INTEGER NOT NULL DEFAULT 0")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE route_rules ADD COLUMN retry_on_529 INTEGER NOT NULL DEFAULT 0")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE route_rules ADD COLUMN retry_all_failures INTEGER NOT NULL DEFAULT 0")
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
      this.db.run("ALTER TABLE providers ADD COLUMN color TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE providers ADD COLUMN flatten_mid_system INTEGER NOT NULL DEFAULT 0")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE providers ADD COLUMN protocol_endpoints TEXT DEFAULT NULL")
    } catch {
      // 列已存在
    }
    try {
      this.db.run("ALTER TABLE providers ADD COLUMN allowed_client_headers TEXT DEFAULT '[]'")
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
    try {
      this.db.run("ALTER TABLE request_logs ADD COLUMN matched_rewrite_rules TEXT DEFAULT NULL")
      this.db.run("ALTER TABLE request_logs ADD COLUMN rewrite_diffs TEXT DEFAULT NULL")
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
      this.db.run("ALTER TABLE route_rules ADD COLUMN fallback_on_client_error INTEGER DEFAULT 0")
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
    try {
      this.db.run("ALTER TABLE route_rules ADD COLUMN thinking_override TEXT DEFAULT NULL")
    } catch { /* 列已存在 */ }
    try {
      this.db.run("ALTER TABLE request_logs ADD COLUMN thinking_log TEXT DEFAULT NULL")
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

    /** 内容改写规则表 */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rewrite_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        match_conditions TEXT NOT NULL DEFAULT '[]',
        action TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        model_pattern TEXT DEFAULT NULL,
        path_pattern TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    /** 消息内容块（内容寻址存储：同内容只存一份，hit_count 记录被多少条日志引用） */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        hash TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      )
    `)

    /** 日志 ↔ 消息块关联（保序） */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS log_messages (
        log_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (log_id, seq)
      )
    `)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_log_messages_hash ON log_messages(hash)`)
    /** pruneOldLogs 按 log_id 范围扫描依赖此索引，否则每轮全表扫描数百万行 */
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_log_messages_log_id ON log_messages(log_id)`)

    /** 消息块附带图片（内容寻址存储：同内容只存一份，hit_count 记录被多少条日志引用） */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS message_images (
        hash TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        size INTEGER NOT NULL DEFAULT 0,
        data BLOB NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    /** 日志 ↔ 消息块图片关联（seq 对应消息块的序号，idx 区分同一条消息内的多张图） */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS log_message_images (
        log_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        idx INTEGER NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (log_id, seq, idx)
      )
    `)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_log_message_images_hash ON log_message_images(hash)`)

    /** 受保护密钥表（Secret Vault：出站脱敏为占位符，入站还原） */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        placeholder TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)

    /** 慢 SQL 日志表：超过阈值的语句执行记录，供管理面板排查 */
    this.db.run(`
      CREATE TABLE IF NOT EXISTS slow_query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        sql TEXT NOT NULL,
        params TEXT NOT NULL,
        duration_ms REAL NOT NULL
      )
    `)
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_slow_query_log_at ON slow_query_log(at)`)
  }

  private prepareStatements() {
    // 预热常用语句
    this.stmt("SELECT value FROM config WHERE key = ?")
    this.stmt("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)")
  }

  // ========== Secrets (Vault) ==========

  /** 获取受保护密钥列表 */
  getSecrets(): SecretEntry[] {
    const rows = this.stmt("SELECT * FROM secrets ORDER BY created_at").all() as Record<string, unknown>[]
    return rows.map(row => ({
      id: row.id as string,
      name: row.name as string,
      placeholder: row.placeholder as string,
      value: row.value as string,
      enabled: row.enabled !== 0,
      createdAt: row.created_at as string,
    }))
  }

  addSecret(secret: SecretEntry) {
    this.stmt("INSERT INTO secrets (id, name, placeholder, value, enabled) VALUES (?, ?, ?, ?, ?)").run(
      secret.id, secret.name, secret.placeholder, secret.value, secret.enabled !== false ? 1 : 0,
    )
  }

  updateSecret(id: string, secret: Partial<SecretEntry>): boolean {
    const sets: string[] = []
    const params: unknown[] = []
    if (secret.name !== undefined) { sets.push("name=?"); params.push(secret.name) }
    if (secret.placeholder !== undefined) { sets.push("placeholder=?"); params.push(secret.placeholder) }
    if (secret.value !== undefined) { sets.push("value=?"); params.push(secret.value) }
    if (secret.enabled !== undefined) { sets.push("enabled=?"); params.push(secret.enabled !== false ? 1 : 0) }
    if (sets.length === 0) return this.getSecret(id) !== null
    params.push(id)
    this.stmt(`UPDATE secrets SET ${sets.join(", ")} WHERE id=?`).run(...params)
    return true
  }

  getSecret(id: string): SecretEntry | null {
    const row = this.stmt("SELECT * FROM secrets WHERE id = ?").get(id) as Record<string, unknown> | null
    if (!row) return null
    return {
      id: row.id as string,
      name: row.name as string,
      placeholder: row.placeholder as string,
      value: row.value as string,
      enabled: row.enabled !== 0,
      createdAt: row.created_at as string,
    }
  }

  deleteSecret(id: string) {
    this.stmt("DELETE FROM secrets WHERE id = ?").run(id)
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
    return rows.map(this.rowToProvider.bind(this))
  }

  getProvider(id: string): ProviderConfig | null {
    const row = this.stmt("SELECT * FROM providers WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? this.rowToProvider(row) : null
  }

  addProvider(provider: ProviderConfig) {
    this.stmt(
      "INSERT INTO providers (id, name, type, base_url, api_key, models, enabled, custom_headers, sort_order, max_concurrency, request_timeout, color, flatten_mid_system, allowed_client_headers, protocol_endpoints) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
      provider.color ?? null,
      provider.flattenMidSystem ? 1 : 0,
      JSON.stringify(provider.allowedClientHeaders ?? []),
      provider.protocolEndpoints && Object.keys(provider.protocolEndpoints).length > 0 ? JSON.stringify(provider.protocolEndpoints) : null,
    )
  }

  updateProvider(id: string, provider: Partial<ProviderConfig>) {
    this.tx(() => {
      const existing = this.getProvider(id)
      if (!existing) return

      const updated = { ...existing, ...this.nullsToUndefined(provider), id } as ProviderConfig
      this.stmt(
        "UPDATE providers SET name=?, type=?, base_url=?, api_key=?, models=?, enabled=?, custom_headers=?, max_concurrency=?, request_timeout=?, color=?, flatten_mid_system=?, allowed_client_headers=?, protocol_endpoints=? WHERE id=?"
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
        updated.color ?? null,
        updated.flattenMidSystem ? 1 : 0,
        JSON.stringify(updated.allowedClientHeaders ?? []),
        updated.protocolEndpoints && Object.keys(updated.protocolEndpoints).length > 0 ? JSON.stringify(updated.protocolEndpoints) : null,
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
      color: (row.color as string) || undefined,
      flattenMidSystem: (row.flatten_mid_system as number) === 1 || undefined,
      allowedClientHeaders: JSON.parse((row.allowed_client_headers as string) || "[]"),
      protocolEndpoints: row.protocol_endpoints ? JSON.parse(row.protocol_endpoints as string) : undefined,
    }
  }

  // ========== Route Rules ==========

  /**
   * 更新接口的「清除字段」协议：JSON 序列化会丢弃 undefined 键，前端只能用 null 表达「清除」。
   * 合并前把所有 null 值归一成 undefined，让展开运算真正覆盖旧值，否则旧值会被静默保留。
   * 所有 partial-merge 式 update* 都必须经过此归一。
   */
  private nullsToUndefined<T extends object>(patch: Partial<T>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) out[k] = v === null ? undefined : v
    return out
  }

  getRouteRules(): RouteRule[] {
    const rows = this.stmt("SELECT * FROM route_rules ORDER BY priority DESC").all() as Record<string, unknown>[]
    return rows.map(this.rowToRouteRule.bind(this))
  }

  /** 按主键查询单条路由规则 */
  getRouteRule(id: string): RouteRule | null {
    const row = this.stmt("SELECT * FROM route_rules WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? this.rowToRouteRule(row) : null
  }

  addRouteRule(rule: RouteRule) {
    this.stmt(
      "INSERT INTO route_rules (id, pattern, provider_id, model_mapping, priority, content_match, match_conditions, target_model, enabled, exclude_match, key_groups, fallbacks, fallback_on_client_error, retry_qpm_limit, retry_on_529, retry_all_failures, thinking_override) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(rule.id, this.extractModelPattern(rule.matchConditions) ?? "", rule.providerId, JSON.stringify(rule.modelMapping ?? {}), rule.priority, null, rule.matchConditions ? JSON.stringify(rule.matchConditions) : null, rule.targetModel ?? null, rule.enabled !== false ? 1 : 0, rule.excludeMatch ? JSON.stringify(rule.excludeMatch) : null, rule.keyGroups ? JSON.stringify(rule.keyGroups) : null, rule.fallbacks ? JSON.stringify(rule.fallbacks) : null, rule.fallbackOnClientError ? 1 : 0, rule.retryQpmLimit ? 1 : 0, rule.retryOn529 ? 1 : 0, rule.retryAllFailures ? 1 : 0, rule.thinkingOverride ? JSON.stringify(rule.thinkingOverride) : null)
  }

  updateRouteRule(id: string, rule: Partial<RouteRule>): boolean {
    return this.tx(() => {
      const existing = this.getRouteRule(id)
      if (!existing) return false

      /**
       * 前端清空可选字段（如删空 matchConditions）时发送 null（JSON 会丢弃 undefined 键，
       * 只能用 null 表达「清除」）。合并前把 null 归一成 undefined，让展开运算真正覆盖旧值。
       */
      const normalized = this.nullsToUndefined(rule)
      const updated = { ...existing, ...normalized, id } as RouteRule
      const modelPattern = this.extractModelPattern(updated.matchConditions) ?? ""
      this.stmt(
        "UPDATE route_rules SET pattern=?, provider_id=?, model_mapping=?, priority=?, content_match=?, match_conditions=?, target_model=?, enabled=?, exclude_match=?, key_groups=?, fallbacks=?, fallback_on_client_error=?, retry_qpm_limit=?, retry_on_529=?, retry_all_failures=?, thinking_override=? WHERE id=?"
      ).run(modelPattern, updated.providerId, JSON.stringify(updated.modelMapping ?? {}), updated.priority, null, updated.matchConditions ? JSON.stringify(updated.matchConditions) : null, updated.targetModel ?? null, updated.enabled !== false ? 1 : 0, updated.excludeMatch ? JSON.stringify(updated.excludeMatch) : null, updated.keyGroups ? JSON.stringify(updated.keyGroups) : null, updated.fallbacks ? JSON.stringify(updated.fallbacks) : null, updated.fallbackOnClientError ? 1 : 0, updated.retryQpmLimit ? 1 : 0, updated.retryOn529 ? 1 : 0, updated.retryAllFailures ? 1 : 0, updated.thinkingOverride ? JSON.stringify(updated.thinkingOverride) : null, id)
      return true
    })
  }

  deleteRouteRule(id: string) {
    this.stmt("DELETE FROM route_rules WHERE id = ?").run(id)
  }

  private rowToRouteRule(row: Record<string, unknown>): RouteRule {
    const matchConditions = row.match_conditions
      ? this.migrateToConditionNode(JSON.parse(row.match_conditions as string))
      : undefined

    /** 向后兼容：若无 match_conditions，从旧字段迁移 */
    let resolvedConditions = matchConditions
    if (!resolvedConditions) {
      const legacyPattern = (row.pattern as string) || ""
      const legacyContentMatch = row.content_match
        ? JSON.parse(row.content_match as string)
        : undefined
      const leaves = this.buildLeavesFromLegacy(legacyPattern, legacyContentMatch)
      if (leaves.length > 0) {
        resolvedConditions = { type: "and", children: leaves }
      }
    }

    /** 排除条件同样需要迁移 */
    let resolvedExclude: ConditionNode | undefined
    if (row.exclude_match) {
      const raw = JSON.parse(row.exclude_match as string)
      resolvedExclude = this.migrateToConditionNode(raw)
    }

    return {
      id: row.id as string,
      providerId: row.provider_id as string,
      modelMapping: JSON.parse((row.model_mapping as string) || "{}"),
      priority: row.priority as number,
      matchConditions: resolvedConditions,
      targetModel: (row.target_model as string) || undefined,
      excludeMatch: resolvedExclude,
      enabled: row.enabled !== 0,
      keyGroups: row.key_groups ? JSON.parse(row.key_groups as string) : undefined,
      retryQpmLimit: (row.retry_qpm_limit as number) === 1 || undefined,
      retryOn529: (row.retry_on_529 as number) === 1 || undefined,
      retryAllFailures: (row.retry_all_failures as number) === 1 || undefined,
      fallbacks: row.fallbacks ? JSON.parse(row.fallbacks as string) : undefined,
      fallbackOnClientError: row.fallback_on_client_error === 1,
      thinkingOverride: row.thinking_override ? JSON.parse(row.thinking_override as string) : undefined,
    }
  }

  /**
   * 将原始 JSON 迁移为 ConditionNode，兼容三种格式：
   * 1. 新格式 ConditionNode（有 children 的对象）→ 直接用
   * 2. 上轮扁平 MatchCondition[]（数组）→ 包装为 { type: op, children: [...] }
   * 3. 其他 → undefined
   */
  private migrateToConditionNode(raw: unknown): ConditionNode | undefined {
    if (!raw) return undefined
    /** 新格式：已经是 ConditionGroup（有 children 字段） */
    if (typeof raw === "object" && !Array.isArray(raw) && "children" in (raw as object)) {
      return raw as ConditionNode
    }
    /** 上轮扁平格式：MatchCondition[]（数组） */
    if (Array.isArray(raw)) {
      const conditions = raw as Array<Record<string, unknown>>
      if (conditions.length === 0) return undefined
      const op = (conditions[0]?.operator as "and" | "or") ?? "and"
      const leaves: ConditionLeaf[] = conditions.map(c => ({
        type: c.type as ConditionLeaf["type"],
        pattern: c.pattern as string,
        ...(c.flags ? { flags: c.flags as string } : {}),
      }))
      return { type: op, children: leaves }
    }
    return undefined
  }

  /** 从旧的 pattern + content_match 字段构建叶子条件列表 */
  private buildLeavesFromLegacy(legacyPattern: string, legacyContentMatch: unknown): ConditionLeaf[] {
    const leaves: ConditionLeaf[] = []
    if (legacyPattern && legacyPattern !== "*") {
      leaves.push({ type: "model", pattern: legacyPattern })
    }
    if (Array.isArray(legacyContentMatch)) {
      for (const c of legacyContentMatch as Array<Record<string, unknown>>) {
        leaves.push({
          type: c.type as ConditionLeaf["type"],
          pattern: c.pattern as string,
          ...(c.flags ? { flags: c.flags as string } : {}),
        })
      }
    }
    return leaves
  }

  /** 从条件树中递归提取第一个 model 类型的 pattern（用于写入旧的 pattern 列） */
  private extractModelPattern(node?: ConditionNode): string | undefined {
    if (!node) return undefined
    if (node.type === "model") return (node as ConditionLeaf).pattern
    if (node.type === "and" || node.type === "or") {
      for (const child of (node as ConditionGroup).children) {
        const found = this.extractModelPattern(child)
        if (found) return found
      }
    }
    return undefined
  }

  // ========== Rewrite Rules ==========

  getRewriteRules(): RewriteRule[] {
    const rows = this.stmt("SELECT * FROM rewrite_rules ORDER BY priority DESC").all() as Record<string, unknown>[]
    return rows.map(this.rowToRewriteRule.bind(this))
  }

  getRewriteRule(id: string): RewriteRule | null {
    const row = this.stmt("SELECT * FROM rewrite_rules WHERE id = ?").get(id) as Record<string, unknown> | null
    return row ? this.rowToRewriteRule(row) : null
  }

  addRewriteRule(rule: RewriteRule) {
    this.stmt(
      "INSERT INTO rewrite_rules (id, name, match_conditions, action, enabled, priority, model_pattern, path_pattern) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(rule.id, rule.name, JSON.stringify(rule.match ?? []), JSON.stringify(rule.actions ?? []), rule.enabled !== false ? 1 : 0, rule.priority, rule.modelPattern ?? null, rule.pathPattern ?? null)
  }

  updateRewriteRule(id: string, rule: Partial<RewriteRule>): boolean {
    return this.tx(() => {
      const existing = this.getRewriteRule(id)
      if (!existing) return false
      const updated = { ...existing, ...this.nullsToUndefined(rule), id } as RewriteRule
      this.stmt(
        "UPDATE rewrite_rules SET name=?, match_conditions=?, action=?, enabled=?, priority=?, model_pattern=?, path_pattern=? WHERE id=?"
      ).run(updated.name, JSON.stringify(updated.match ?? []), JSON.stringify(updated.actions ?? []), updated.enabled !== false ? 1 : 0, updated.priority, updated.modelPattern ?? null, updated.pathPattern ?? null, id)
      return true
    })
  }

  deleteRewriteRule(id: string) {
    this.stmt("DELETE FROM rewrite_rules WHERE id = ?").run(id)
  }

  private rowToRewriteRule(row: Record<string, unknown>): RewriteRule {
    /** action 列存动作组 JSON 数组；兼容旧版单动作对象格式，并归一化旧动作类型 */
    const parsedAction: unknown = JSON.parse((row.action as string) || "[]")
    const rawActions: Record<string, unknown>[] = Array.isArray(parsedAction) ? parsedAction : [parsedAction]
    const matchConditions: RewriteMatchCondition[] = JSON.parse((row.match_conditions as string) || "[]")
    const actions = rawActions
      .filter(a => !!a && typeof a === "object")
      .map((a): RewriteAction => {
        /** type 来自反序列化的 JSON，先按 unknown 收窄（旧版可能是 replace/replace_all） */
        const rawType: unknown = a.type
        const type = (typeof rawType === "string" ? rawType : "") as RewriteAction["type"] | "replace" | "replace_all"
        const pattern = typeof a.pattern === "string" ? a.pattern : undefined
        const flags = typeof a.flags === "string" ? a.flags : undefined
        /** 旧版 replace/replace_all 归一化为 regex_replace；无 pattern 时物化匹配条件的 pattern */
        const normalizedType: RewriteAction["type"] = type === "replace" || type === "replace_all" ? "regex_replace" : type
        if (normalizedType === "regex_replace" && !pattern && matchConditions[0]?.pattern) {
          return {
            type: normalizedType,
            replacement: typeof a.replacement === "string" ? a.replacement : "",
            pattern: matchConditions[0].pattern,
            flags: flags ?? matchConditions[0].flags,
          }
        }
        return {
          type: normalizedType,
          replacement: typeof a.replacement === "string" ? a.replacement : "",
          ...(pattern !== undefined ? { pattern } : {}),
          ...(flags !== undefined ? { flags } : {}),
        }
      })
    return {
      id: row.id as string,
      name: row.name as string,
      match: matchConditions,
      actions,
      enabled: row.enabled !== 0,
      priority: row.priority as number,
      modelPattern: (row.model_pattern as string) || undefined,
      pathPattern: (row.path_pattern as string) || undefined,
      createdAt: row.created_at as string,
    }
  }

  // ========== Request Logs ==========

  /** 日志清理间隔 */
  private static PRUNE_INTERVAL_MS = 60_000

  addLog(log: Omit<RequestLogEntry, "id" | "timestamp">): number | null {
    /** DB 已关闭（优雅关机期间流式请求可能仍在写入日志） */
    if (this.closed) return null
    /** 完整保留内容，数据量由 pruneLogContent / pruneOldLogs 按保留策略清理 */
    const inputContent = log.inputContent ?? null
    const outputContent = log.outputContent ?? null
    const messages = log.inputMessagesForWrite ?? []

    return this.tx(() => {
      const result = this.stmt(
        "INSERT INTO request_logs (method, path, model, provider_id, target_model, stream, status_code, duration_ms, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, error, input_content, output_content, api_key_id, group_id, fallback_attempts, matched_rewrite_rules, rewrite_diffs, thinking_log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
        log.matchedRewriteRules ?? null,
        log.rewriteDiffs ?? null,
        log.thinkingLog ?? null,
      )
      const logId = Number(result.lastInsertRowid)

      /** 消息级内容寻址存储：同 role+内容 只存一份，hit_count 记该块被引用的总出现次数（与 prune 的 COUNT(*) 递减对称） */
      for (const [seq, msg] of messages.entries()) {
        const hash = createHash("sha256").update(`${msg.role}${msg.content}`).digest("hex")
        this.stmt(`
          INSERT INTO messages (hash, role, content, hit_count, size, last_used_at) VALUES (?, ?, ?, 1, ?, datetime('now'))
          ON CONFLICT(hash) DO UPDATE SET hit_count = hit_count + 1, last_used_at = datetime('now')
        `).run(hash, msg.role, msg.content, msg.content.length)
        this.stmt("INSERT INTO log_messages (log_id, seq, hash) VALUES (?, ?, ?)").run(logId, seq, hash)
      }
      return logId
    })
  }

  /** 写入消息块图片附件：内容寻址去重 + 关联到具体日志的消息块序号（异步旁路调用，与消息块同生命周期） */
  addMessageImages(logId: number, images: { seq: number; mediaType: string; width: number; height: number; data: Buffer }[]) {
    if (images.length === 0) return
    this.tx(() => {
      for (const [idx, img] of images.entries()) {
        const hash = createHash("sha256").update(img.data).digest("hex")
        this.stmt(`
          INSERT INTO message_images (hash, media_type, width, height, size, data, hit_count) VALUES (?, ?, ?, ?, ?, ?, 1)
          ON CONFLICT(hash) DO UPDATE SET hit_count = hit_count + 1
        `).run(hash, img.mediaType, img.width, img.height, img.data.length, img.data)
        this.stmt("INSERT INTO log_message_images (log_id, seq, idx, hash) VALUES (?, ?, ?, ?)").run(logId, img.seq, idx, hash)
      }
    })
  }
  /** 获取单条日志所有图片的元数据（不含字节流，字节流走 getImageBytes 按需取） */
  getLogImages(logId: number): (LogImage & { seq: number })[] {
    const rows = this.stmt(`
      SELECT lmi.seq AS seq, mi.hash, mi.media_type, mi.width, mi.height, mi.size
      FROM log_message_images lmi JOIN message_images mi ON mi.hash = lmi.hash
      WHERE lmi.log_id = ? ORDER BY lmi.seq, lmi.idx
    `).all(logId) as Record<string, unknown>[]
    return rows.map(r => ({
      seq: r.seq as number,
      hash: r.hash as string,
      mediaType: r.media_type as string,
      width: r.width as number,
      height: r.height as number,
      size: r.size as number,
    }))
  }

  /** 获取图片字节流（校验 hash 确实关联到该日志） */
  getImageBytes(logId: number, hash: string): { mediaType: string; data: Buffer } | null {
    const row = this.stmt(`
      SELECT mi.media_type, mi.data FROM log_message_images lmi
      JOIN message_images mi ON mi.hash = lmi.hash
      WHERE lmi.log_id = ? AND lmi.hash = ?
    `).get(logId, hash) as Record<string, unknown> | undefined
    if (!row) return null
    return { mediaType: row.media_type as string, data: row.data as Buffer }
  }

  /** 清理超出保留数量的旧日志 content 字段（按上次水位增量执行，避免每轮重复扫描已清理行） */
  private pruneLogContent() {
    const retention = Math.max(1, Math.floor(Number(this.getConfig().logContentRetention ?? 1000)))
    this.tx(() => {
      const row = this.stmt("SELECT id FROM request_logs ORDER BY id DESC LIMIT 1 OFFSET ?").get(retention - 1) as { id: number } | undefined
      if (row && row.id > this.contentPruneWatermark) {
        this.stmt("UPDATE request_logs SET input_content = NULL, output_content = NULL WHERE id > ? AND id <= ? AND (input_content IS NOT NULL OR output_content IS NOT NULL)").run(this.contentPruneWatermark, row.id)
        this.contentPruneWatermark = row.id
      }
    })
  }

  /** content 清理水位：已置空到该 log_id（含），下轮只处理其后新增的行 */
  private contentPruneWatermark = 0

  /** 日志删除水位：已删除到该 log_id（含），下轮只处理增量，避免全量重算引用计数 */
  private logPruneWatermark = 0

  /** 删除超量旧日志行，保留最近 maxLogRows 条；按水位增量维护消息块引用计数并清理无引用块 */
  private pruneOldLogs() {
    const maxRows = Math.max(1000, this.getConfig().maxLogRows ?? 100000)
    this.tx(() => {
      const row = this.stmt("SELECT id FROM request_logs ORDER BY id DESC LIMIT 1 OFFSET ?").get(maxRows - 1) as { id: number } | undefined
      /** 无需删除，或水位未推进（retention 配置调大后不回滚已删数据） */
      if (!row || row.id <= this.logPruneWatermark) return

      /** 本次增量删除区间：上次水位之后到新边界，索引范围扫描代替全表 GROUP BY */
      const upto = row.id
      const since = this.logPruneWatermark

      /** 待删日志中各消息块的引用数（log_id 索引范围扫描） */
      const refs = this.stmt("SELECT hash, COUNT(*) AS n FROM log_messages WHERE log_id > ? AND log_id <= ? GROUP BY hash").all(since, upto)
      for (const ref of refs as { hash: string; n: number }[]) {
        this.stmt("UPDATE messages SET hit_count = hit_count - ? WHERE hash = ?").run(ref.n, ref.hash)
      }
      this.stmt("DELETE FROM log_messages WHERE log_id > ? AND log_id <= ?").run(since, upto)
      this.stmt("DELETE FROM messages WHERE hit_count <= 0").run()

      /** 图片附件同生命周期：递减引用计数，无引用即删除字节流 */
      const imgRefs = this.stmt("SELECT hash, COUNT(*) AS n FROM log_message_images WHERE log_id > ? AND log_id <= ? GROUP BY hash").all(since, upto)
      for (const ref of imgRefs as { hash: string; n: number }[]) {
        this.stmt("UPDATE message_images SET hit_count = hit_count - ? WHERE hash = ?").run(ref.n, ref.hash)
      }
      this.stmt("DELETE FROM log_message_images WHERE log_id > ? AND log_id <= ?").run(since, upto)
      this.stmt("DELETE FROM message_images WHERE hit_count <= 0").run()
      this.stmt("DELETE FROM request_logs WHERE id > ? AND id <= ?").run(since, upto)

      this.logPruneWatermark = upto
    })
  }

  /** 高频消息块统计（按引用数或累计字节量排序） */
  getTopMessages(limit = 20, by: "refs" | "bytes" = "bytes"): (LogMessage & { size: number; lastUsedAt: string | null })[] {
    const orderBy = by === "refs" ? "hit_count DESC" : "hit_count * size DESC"
    const rows = this.stmt(`SELECT hash, role, content, hit_count, size, last_used_at FROM messages WHERE hit_count > 0 ORDER BY ${orderBy} LIMIT ?`).all(limit) as Record<string, unknown>[]
    return rows.map(r => ({
      hash: r.hash as string,
      role: r.role as string,
      content: r.content as string,
      hitCount: r.hit_count as number,
      size: r.size as number,
      lastUsedAt: (r.last_used_at as string) ?? null,
    }))
  }

  getLogs(options: { limit?: number; offset?: number; model?: string; providerId?: string; apiKeyId?: string; groupId?: string; status?: string; sort?: string; startTime?: string; endTime?: string; hasFallback?: boolean } = {}): RequestLogEntry[] {
    const { limit = 100, offset = 0, model, providerId, apiKeyId, groupId, status, sort, startTime, endTime, hasFallback } = options

    /** 列表查询排除大字段 input_content/output_content，按需通过 getLogDetail 加载 */
    let sql = "SELECT id, timestamp, method, path, model, provider_id, target_model, stream, status_code, duration_ms, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, error, api_key_id, group_id, fallback_attempts, matched_rewrite_rules FROM request_logs WHERE 1=1"
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

  /** 获取单条日志详情（包含 input_content/output_content；消息块存储的日志重组出结构化消息数组） */
  getLogDetail(id: number): RequestLogEntry | null {
    const row = this.stmt("SELECT * FROM request_logs WHERE id = ?").get(id) as Record<string, unknown> | undefined
    if (!row) return null
    const entry = this.rowToLog(row)

    const msgRows = this.stmt(`
      SELECT m.hash, m.role, m.content, m.hit_count
      FROM log_messages lm JOIN messages m ON m.hash = lm.hash
      WHERE lm.log_id = ? ORDER BY lm.seq
    `).all(id) as Record<string, unknown>[]
    if (msgRows.length) {
      entry.inputMessages = msgRows.map(r => ({
        hash: r.hash as string,
        role: r.role as string,
        content: r.content as string,
        hitCount: r.hit_count as number,
      }))
      /** 多轮对话标记：hash 在更早的日志中已出现过 → 历史上下文（本轮非新增）。
       *  索引为 (hash, log_id) 复合序：按 hash 定位后 log_id 有序，LIMIT 1 直接命中最早一条，
       *  代替旧的 hash IN (...) GROUP BY（会把每个 hash 的全部历史行扫出来，热 hash 被数万日志引用，实测 3766ms）*/
      const seenStmt = this.stmt("SELECT 1 FROM log_messages WHERE hash = ? AND log_id < ? LIMIT 1")
      for (const msg of entry.inputMessages) {
        if (seenStmt.get(msg.hash, id)) msg.seenBefore = true
      }
      /** 图片附件按 seq 挂回对应消息块 */
      const images = this.getLogImages(id)
      for (const img of images) {
        const msg = entry.inputMessages[img.seq]
        if (!msg) continue
        if (!msg.images) msg.images = []
        msg.images.push({ hash: img.hash, mediaType: img.mediaType, width: img.width, height: img.height, size: img.size })
      }
      /** 兼容旧读取方：无原始 input_content 时拼接重组 */
      if (!entry.inputContent) entry.inputContent = entry.inputMessages.map(m => m.content).join("\n")
    }
    return entry
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
      matchedRewriteRules: (row.matched_rewrite_rules as string) || null,
      rewriteDiffs: (row.rewrite_diffs as string) || null,
      thinkingLog: (row.thinking_log as string) || null,
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
    return rows.map(this.rowToKeyGroup.bind(this))
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
      const updated = { ...existing, ...this.nullsToUndefined(group), id } as KeyGroup
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
    return rows.map(this.rowToApiKey.bind(this))
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
      const updated = { ...existing, ...this.nullsToUndefined(key), id } as ApiKey
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
      const updated = { ...existing, ...this.nullsToUndefined(config), id } as CurlQueryConfig
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

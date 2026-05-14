import { existsSync } from "node:fs"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import type { GatewayConfig } from "./types.ts"

/** data/config.json 的完整结构 */
export interface AppConfig {
  admin?: {
    username: string
    /** bcrypt hash of password */
    passwordHash: string
  }
  /** 是否要求 API 请求必须携带有效 Key */
  authRequired: boolean
  /** 网关基础配置 */
  gateway: GatewayConfig
}

const DEFAULT_APP_CONFIG: AppConfig = {
  authRequired: false,
  gateway: {
    port: 3827,
    logLevel: "info",
    enableRequestLog: true,
    logContentRetention: 1000,
    authRequired: false,
  },
}

const CONFIG_DIR = "data"
const CONFIG_PATH = join(CONFIG_DIR, "config.json")

export class ConfigManager {
  private config: AppConfig
  private configPath: string

  constructor(configDir?: string) {
    this.configPath = configDir ? join(configDir, "config.json") : CONFIG_PATH
    this.config = this.load()
  }

  private load(): AppConfig {
    if (!existsSync(this.configPath)) {
      const dir = dirname(this.configPath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      const defaultConfig = { ...DEFAULT_APP_CONFIG }
      writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2))
      return defaultConfig
    }
    const raw = readFileSync(this.configPath, "utf-8")
    const parsed = JSON.parse(raw)
    return {
      ...DEFAULT_APP_CONFIG,
      ...parsed,
      gateway: { ...DEFAULT_APP_CONFIG.gateway, ...parsed.gateway },
    }
  }

  private save() {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2))
  }

  get(): Readonly<AppConfig> {
    return this.config
  }

  /** 管理员是否已初始化 */
  isAdminInitialized(): boolean {
    return !!(this.config.admin?.username && this.config.admin?.passwordHash)
  }

  /** 初始化管理员帐号 */
  async initAdmin(username: string, password: string) {
    const passwordHash = await this.hashPassword(password)
    this.config.admin = { username, passwordHash }
    this.save()
  }

  /** 修改管理员密码 */
  async changePassword(newPassword: string) {
    if (!this.config.admin) throw new Error("Admin not initialized")
    this.config.admin.passwordHash = await this.hashPassword(newPassword)
    this.save()
  }

  /** 验证管理员凭据 */
  async verifyAdmin(username: string, password: string): Promise<boolean> {
    if (!this.config.admin) return false
    return this.config.admin.username === username && Bun.password.verify(password, this.config.admin.passwordHash)
  }

  /** 设置 authRequired 开关 */
  setAuthRequired(value: boolean) {
    this.config.authRequired = value
    this.config.gateway.authRequired = value
    this.save()
  }

  /** 更新网关配置 */
  updateGateway(partial: Partial<GatewayConfig>) {
    this.config.gateway = { ...this.config.gateway, ...partial }
    this.save()
  }

  /** 密码哈希：使用 Bun 内置 bcrypt */
  private async hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password)
  }
}

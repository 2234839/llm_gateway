import { existsSync } from "node:fs"
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
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
    maxLogRows: 100000,
    authRequired: false,
  },
}

const CONFIG_DIR = "data"
const CONFIG_PATH = join(CONFIG_DIR, "config.json")

export class ConfigManager {
  private config: AppConfig
  private configPath: string
  /** 写入串行化队列：防止并发 write 导致数据丢失 */
  private writeQueue: Promise<void> = Promise.resolve()

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

  /** 原子写入：先写临时文件再 rename，防止中途崩溃导致配置损坏 */
  private save() {
    const tmp = this.configPath + ".tmp"
    writeFileSync(tmp, JSON.stringify(this.config, null, 2))
    renameSync(tmp, this.configPath)
  }

  /** 串行化异步写入：排队执行，防止并发修改丢失 */
  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const prev = this.writeQueue
    let resolve!: () => void
    this.writeQueue = new Promise(r => { resolve = r })
    return prev.then(() => fn()).finally(resolve)
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
    return this.enqueueWrite(async () => {
      const passwordHash = await this.hashPassword(password)
      this.config.admin = { username, passwordHash }
      this.save()
    })
  }

  /** 修改管理员密码 */
  async changePassword(newPassword: string) {
    return this.enqueueWrite(async () => {
      if (!this.config.admin) throw new Error("Admin not initialized")
      this.config.admin.passwordHash = await this.hashPassword(newPassword)
      this.save()
    })
  }

  /** 验证管理员凭据 */
  async verifyAdmin(username: string, password: string): Promise<boolean> {
    if (!this.config.admin) return false
    /** 无论用户名是否匹配都验证密码，避免时序攻击泄露用户名 */
    const usernameMatch = timingSafeEqual(this.config.admin.username, username)
    const passwordMatch = await Bun.password.verify(password, this.config.admin.passwordHash)
    return usernameMatch && passwordMatch
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

/** 常量时间字符串比较，防止时序攻击 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a)
  const bufB = new TextEncoder().encode(b)
  if (bufA.length !== bufB.length) {
    /** 长度不等时仍做完整比较，避免通过比较时长泄露长度信息 */
    const longer = bufA.length > bufB.length ? bufA : bufB
    let dummy = 0
    for (let i = 0; i < longer.length; i++) dummy |= longer[i]!
    return false
  }
  let result = 0
  for (let i = 0; i < bufA.length; i++) result |= bufA[i]! ^ bufB[i]!
  return result === 0
}

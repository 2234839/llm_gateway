import type { Provider, ProviderConfig, RouteResult, ContentMatchCondition } from "../types.ts"
import picomatch from "picomatch"
import { OpenAIProvider } from "./openai.ts"
import { AnthropicProvider } from "./anthropic.ts"
import { GatewayDB } from "../db.ts"
import { Semaphore } from "../utils/semaphore.ts"

export interface ResolveContext {
  /** 请求消息中提取的全部纯文本 */
  messageText: string
  /** 请求中包含的多模态内容类型 (image/file/tool_use) */
  contentTypes: Set<string>
  /** 请求来源的密钥分组 ID */
  groupId?: string
}

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map()
  private semaphores: Map<string, Semaphore> = new Map()
  private db: GatewayDB
  /** 缓存的路由规则 */
  private cachedRules: ReturnType<GatewayDB["getRouteRules"]> | null = null
  /** 缓存的 provider 配置（reload 时刷新） */
  private providerConfigs: Map<string, ProviderConfig> = new Map()
  /** 可用模型列表缓存：groupId|undefined -> { result, ts } */
  private modelsCache = new Map<string, { result: { id: string; owned_by: string }[]; ts: number }>()
  /** 模型缓存 TTL：30 秒 */
  private static MODELS_CACHE_TTL = 30_000

  constructor(db: GatewayDB) {
    this.db = db
    this.reload()
  }

  /** 从数据库重新加载所有提供商配置（原子替换，避免并发请求看到空状态） */
  reload() {
    const newProviders = new Map<string, Provider>()
    const newSemaphores = new Map<string, Semaphore>()
    const newConfigs = new Map<string, ProviderConfig>()
    const configs = this.db.getProviders()
    for (const config of configs) {
      newConfigs.set(config.id, config)
      if (!config.enabled) continue
      newProviders.set(config.id, this.createProvider(config))
      if (config.maxConcurrency && config.maxConcurrency > 0) {
        newSemaphores.set(config.id, new Semaphore(config.maxConcurrency))
      }
    }
    /** 保留已有信号量的当前并发状态，避免 reload 中断进行中的请求 */
    for (const [id, newSem] of newSemaphores) {
      const oldSem = this.semaphores.get(id)
      if (oldSem && oldSem.max === newSem.max) {
        newSemaphores.set(id, oldSem)
      }
    }
    this.providers = newProviders
    this.semaphores = newSemaphores
    this.cachedRules = null
    this.providerConfigs = newConfigs
    this.modelsCache.clear()
  }

  /** 使路由规则缓存失效（admin 修改规则后调用） */
  invalidateRules() {
    this.cachedRules = null
    this.modelsCache.clear()
    regexCache.clear()
    picomatchCache.clear()
  }

  /** 获取路由规则（带缓存） */
  private getRules() {
    if (!this.cachedRules) {
      this.cachedRules = this.db.getRouteRules()
    }
    return this.cachedRules
  }

  private createProvider(config: ProviderConfig): Provider {
    switch (config.type) {
      case "anthropic":
        return new AnthropicProvider(config.id, config.baseUrl, config.apiKey, config.customHeaders, config.requestTimeout)
      case "openai":
      case "azure-openai":
      case "custom":
        return new OpenAIProvider(config.id, config.type, config.baseUrl, config.apiKey, config.customHeaders, config.requestTimeout)
      default:
        throw new Error(`Unknown provider type: ${config.type}`)
    }
  }

  /** 根据模型名和可选的消息内容匹配路由规则 */
  resolve(model: string, context?: ResolveContext): RouteResult {
    const rules = this.getRules()

    for (const rule of rules) {
      if (rule.enabled === false) continue

      /** 模型名匹配：pattern 为空或 * 时不过滤 */
      if (rule.pattern && rule.pattern !== "*") {
        if (!getCachedPicomatch(rule.pattern)(model)) continue
      }

      /** 密钥分组匹配：规则指定了 keyGroups 时，请求的 groupId 必须在列表中 */
      if (rule.keyGroups && rule.keyGroups.length > 0) {
        if (!context?.groupId) continue
        if (!rule.keyGroups.includes(context.groupId)) continue
      }

      /** 内容匹配 */
      if (rule.contentMatch && rule.contentMatch.length > 0) {
        if (!context?.messageText && !context?.contentTypes?.size) continue
        if (!matchContent(rule.contentMatch, context?.messageText ?? "", context?.contentTypes ?? new Set())) continue
      }

      /** 排除条件：命中则跳过此规则 */
      if (rule.excludeMatch && rule.excludeMatch.length > 0) {
        if (context?.messageText || context?.contentTypes?.size) {
          if (matchContent(rule.excludeMatch, context?.messageText ?? "", context?.contentTypes ?? new Set())) continue
        }
      }

      const provider = this.providers.get(rule.providerId)
      if (!provider) continue

      const targetModel = rule.targetModel || rule.modelMapping?.[model] || model
      const providerConfig = this.providerConfigs.get(rule.providerId)
      if (!providerConfig) continue

      /** 构建有效 fallback 列表（过滤掉不可用的 provider） */
      const fallbacks = (rule.fallbacks ?? []).filter(fb => this.providers.has(fb.providerId))

      return {
        provider,
        targetModel,
        providerConfig,
        rulePattern: rule.pattern || null,
        fallbacks,
      }
    }

    /** 无匹配规则时，给出更友好的错误提示 */
    const enabledCount = rules.filter(r => r.enabled !== false).length
    const totalProviders = this.providers.size
    const hints: string[] = [`No route rule matched for model: ${model}`]
    if (enabledCount === 0) {
      hints.push("No enabled route rules found")
    } else if (totalProviders === 0) {
      hints.push("No enabled providers found")
    }
    const available = this.getAvailableModels(context?.groupId)
    if (available.length > 0) {
      hints.push(`Available models: ${available.slice(0, 10).map(m => m.id).join(", ")}${available.length > 10 ? " ..." : ""}`)
    }
    throw new Error(hints.join(". "))
  }

  getProvider(id: string): Provider | undefined {
    return this.providers.get(id)
  }

  /** 获取 provider 配置（从缓存，不查 DB） */
  getProviderConfig(id: string): ProviderConfig | undefined {
    return this.providerConfigs.get(id)
  }

  /** 获取所有 provider 配置（从缓存，不查 DB） */
  getProviderConfigs(): ProviderConfig[] {
    return [...this.providerConfigs.values()]
  }

  /** 获取路由规则数量（从缓存，不查 DB） */
  getRuleCount(): number {
    return this.getRules().length
  }

  /** 获取指定 provider 的并发信号量，无限制时返回 undefined */
  getSemaphore(providerId: string): Semaphore | undefined {
    return this.semaphores.get(providerId)
  }

  /** 获取所有 provider 的实时并发状态 */
  getConcurrencyStatus(): { id: string; name: string; current: number; max: number }[] {
    const result: { id: string; name: string; current: number; max: number }[] = []
    for (const config of this.providerConfigs.values()) {
      if (!config.enabled) continue
      const sem = this.semaphores.get(config.id)
      result.push({
        id: config.id,
        name: config.name,
        current: sem?.current ?? 0,
        max: sem ? sem.max : config.maxConcurrency ?? 0,
      })
    }
    return result
  }

  /** 获取可用模型列表：基于路由规则匹配 provider 中的模型，去重返回（带 TTL 缓存） */
  getAvailableModels(groupId?: string): { id: string; owned_by: string }[] {
    const cacheKey = groupId ?? ""
    const cached = this.modelsCache.get(cacheKey)
    if (cached && Date.now() - cached.ts < ProviderRegistry.MODELS_CACHE_TTL) return cached.result

    const rules = this.getRules()
    const seen = new Set<string>()
    const models: { id: string; owned_by: string }[] = []

    for (const rule of rules) {
      if (rule.enabled === false) continue
      if (rule.keyGroups && rule.keyGroups.length > 0) {
        if (!groupId || !rule.keyGroups.includes(groupId)) continue
      }

      const config = this.providerConfigs.get(rule.providerId)
      if (!config || !config.enabled) continue

      /** pattern 为空或 * 时，包含该 provider 所有模型 */
      const isWildcard = !rule.pattern || rule.pattern === "*"
      for (const model of config.models) {
        if (seen.has(model)) continue
        if (!isWildcard && !getCachedPicomatch(rule.pattern)(model)) continue
        seen.add(model)
        models.push({
          id: model,
          owned_by: config.type === "anthropic" ? "anthropic" : config.type,
        })
      }
    }
    this.modelsCache.set(cacheKey, { result: models, ts: Date.now() })
    return models
  }
}

/** 正则编译缓存：key = `${flags}:${pattern}` */
const regexCache = new Map<string, RegExp | null>()

/** picomatch matcher 缓存：key = pattern */
const picomatchCache = new Map<string, (input: string) => boolean>()

const MAX_PATTERN_CACHE = 200

/** 获取或创建 picomatch matcher */
function getCachedPicomatch(pattern: string): (input: string) => boolean {
  let matcher = picomatchCache.get(pattern)
  if (!matcher) {
    if (picomatchCache.size >= MAX_PATTERN_CACHE) picomatchCache.clear()
    matcher = picomatch(pattern)
    picomatchCache.set(pattern, matcher)
  }
  return matcher
}

/** 获取或编译正则表达式，缓存编译结果 */
function getCachedRegex(pattern: string, flags: string): RegExp | null {
  const key = `${flags}:${pattern}`
  const cached = regexCache.get(key)
  if (cached !== undefined) return cached
  if (regexCache.size >= MAX_PATTERN_CACHE) regexCache.clear()
  try {
    const re = new RegExp(pattern, flags)
    regexCache.set(key, re)
    return re
  } catch {
    regexCache.set(key, null)
    return null
  }
}

/** 测试文本是否满足一组内容匹配条件 */
function matchContent(conditions: ContentMatchCondition[], text: string, contentTypes: Set<string>): boolean {
  const operator = conditions[0]?.operator ?? "and"

  const results = conditions.map(cond => {
    if (cond.type === "content_type") {
      return contentTypes.has(cond.pattern)
    }
    if (cond.type === "keyword") {
      return text.includes(cond.pattern)
    }
    const re = getCachedRegex(cond.pattern, cond.flags ?? "")
    return re ? re.test(text) : false
  })

  return operator === "or"
    ? results.some(Boolean)
    : results.every(Boolean)
}

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
}

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map()
  private semaphores: Map<string, Semaphore> = new Map()
  private db: GatewayDB

  constructor(db: GatewayDB) {
    this.db = db
    this.reload()
  }

  /** 从数据库重新加载所有提供商配置 */
  reload() {
    this.providers.clear()
    this.semaphores.clear()
    const configs = this.db.getProviders()
    for (const config of configs) {
      if (!config.enabled) continue
      this.providers.set(config.id, this.createProvider(config))
      if (config.maxConcurrency && config.maxConcurrency > 0) {
        this.semaphores.set(config.id, new Semaphore(config.maxConcurrency))
      }
    }
  }

  private createProvider(config: ProviderConfig): Provider {
    switch (config.type) {
      case "anthropic":
        return new AnthropicProvider(config.id, config.baseUrl, config.apiKey, config.customHeaders)
      case "openai":
      case "azure-openai":
      case "custom":
        return new OpenAIProvider(config.id, config.type, config.baseUrl, config.apiKey, config.customHeaders)
    }
  }

  /** 根据模型名和可选的消息内容匹配路由规则 */
  resolve(model: string, context?: ResolveContext): RouteResult {
    const rules = this.db.getRouteRules()

    for (const rule of rules) {
      if (rule.enabled === false) continue

      /** 模型名匹配：pattern 为空或 * 时不过滤 */
      if (rule.pattern && rule.pattern !== "*") {
        if (!picomatch(rule.pattern)(model)) continue
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
      const providerConfig = this.db.getProvider(rule.providerId)
      return {
        provider,
        targetModel,
        providerConfig: providerConfig!,
      }
    }

    throw new Error(`No route rule matched for model: ${model}`)
  }

  getProvider(id: string): Provider | undefined {
    return this.providers.get(id)
  }

  /** 获取指定 provider 的并发信号量，无限制时返回 undefined */
  getSemaphore(providerId: string): Semaphore | undefined {
    return this.semaphores.get(providerId)
  }

  /** 获取所有 provider 的实时并发状态 */
  getConcurrencyStatus(): { id: string; name: string; current: number; max: number }[] {
    const configs = this.db.getProviders()
    const result: { id: string; name: string; current: number; max: number }[] = []
    for (const config of configs) {
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

  /** 获取所有可用模型列表 */
  getAvailableModels(): { id: string; owned_by: string }[] {
    const models: { id: string; owned_by: string }[] = []
    const configs = this.db.getProviders()

    for (const config of configs) {
      if (!config.enabled) continue
      for (const model of config.models) {
        models.push({
          id: model,
          owned_by: config.type === "anthropic" ? "anthropic" : config.type,
        })
      }
    }

    return models
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
    try {
      return new RegExp(cond.pattern, cond.flags ?? "").test(text)
    } catch {
      return false
    }
  })

  return operator === "or"
    ? results.some(Boolean)
    : results.every(Boolean)
}

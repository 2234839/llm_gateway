import type { Provider, ProviderConfig, RouteResult, ConditionNode, ConditionLeaf, ConditionGroup } from "../types.ts"
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
  /**
   * 请求的预估总 token 预算 = 预估 input token + max_tokens(completion)。
   * 按字符类别加权估算 input（无需分词器），加上客户端指定的 completion 上限，
   * 用于与目标模型的上下文窗口限制做比对。
   */
  tokenCount: number
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
    compiledCache.clear()
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

      /** 密钥分组匹配：规则指定了 keyGroups 时，请求的 groupId 必须在列表中 */
      if (rule.keyGroups && rule.keyGroups.length > 0) {
        if (!context?.groupId) continue
        if (!rule.keyGroups.includes(context.groupId)) continue
      }

      /** 统一匹配条件（递归嵌套树） */
      if (rule.matchConditions) {
        const fn = compileCondition(rule.matchConditions)
        if (!fn(model, context?.messageText ?? "", context?.contentTypes ?? new Set(), context?.tokenCount ?? 0)) continue
      }

      /** 排除条件：命中则跳过此规则 */
      if (rule.excludeMatch) {
        if (context?.messageText || context?.contentTypes?.size) {
          const fn = compileCondition(rule.excludeMatch)
          if (fn(model, context?.messageText ?? "", context?.contentTypes ?? new Set(), context?.tokenCount ?? 0)) continue
        }
      }

      const provider = this.providers.get(rule.providerId)
      if (!provider) continue

      const targetModel = rule.targetModel || rule.modelMapping?.[model] || model
      const providerConfig = this.providerConfigs.get(rule.providerId)
      if (!providerConfig) continue

      /** 构建有效 fallback 列表（过滤掉不可用的 provider） */
      const fallbacks = (rule.fallbacks ?? []).filter(fb => this.providers.has(fb.providerId))

      /** 提取模型 pattern 用于 rulePattern 字段 */
      const modelPattern = extractModelPatternFromTree(rule.matchConditions)

      return {
        provider,
        targetModel,
        providerConfig,
        rulePattern: modelPattern,
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
  getConcurrencyStatus(): { id: string; name: string; current: number; max: number; color?: string }[] {
    const result: { id: string; name: string; current: number; max: number; color?: string }[] = []
    for (const config of this.providerConfigs.values()) {
      if (!config.enabled) continue
      const sem = this.semaphores.get(config.id)
      result.push({
        id: config.id,
        name: config.name,
        current: sem?.current ?? 0,
        max: sem ? sem.max : config.maxConcurrency ?? 0,
        color: config.color,
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

      /** 从条件树中提取模型 pattern */
      const modelPattern = extractModelPatternFromTree(rule.matchConditions)
      const isWildcard = !modelPattern || modelPattern === "*"
      for (const model of config.models) {
        if (seen.has(model)) continue
        if (!isWildcard && !getCachedPicomatch(modelPattern!)(model)) continue
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

/** 淘汰 Map 中最早插入的一半条目，避免全量清除导致缓存雪崩 */
function evictHalf<K, V>(map: Map<K, V>) {
  let count = 0
  for (const key of map.keys()) {
    if (++count > map.size / 2) break
    map.delete(key)
  }
}

/** 获取或创建 picomatch matcher */
export function getCachedPicomatch(pattern: string): (input: string) => boolean {
  let matcher = picomatchCache.get(pattern)
  if (!matcher) {
    if (picomatchCache.size >= MAX_PATTERN_CACHE) evictHalf(picomatchCache)
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
  if (regexCache.size >= MAX_PATTERN_CACHE) evictHalf(regexCache)
  try {
    const re = new RegExp(pattern, flags)
    regexCache.set(key, re)
    return re
  } catch {
    regexCache.set(key, null)
    return null
  }
}

/** 编译后的条件求值函数签名 */
type CompiledCondition = (model: string, text: string, contentTypes: Set<string>, tokenCount: number) => boolean

/** 条件树编译缓存：key = JSON.stringify(node) */
const compiledCache = new Map<string, CompiledCondition>()
const MAX_COMPILED_CACHE = 200

/**
 * 将条件树编译为可复用的求值函数。
 * 规则不变时复用已编译函数，避免每次请求都遍历树结构。
 */
function compileCondition(node: ConditionNode): CompiledCondition {
  const key = JSON.stringify(node)
  const cached = compiledCache.get(key)
  if (cached) return cached

  const fn = doCompile(node)

  if (compiledCache.size >= MAX_COMPILED_CACHE) evictHalf(compiledCache)
  compiledCache.set(key, fn)
  return fn
}

/** 实际编译逻辑：递归将条件树转为嵌套函数调用 */
function doCompile(node: ConditionNode): CompiledCondition {
  /** 逻辑组 */
  if (node.type === "and" || node.type === "or") {
    const group = node as ConditionGroup
    const compiledChildren = group.children.map(doCompile)
    if (group.type === "and") {
      return (model, text, contentTypes, tokenCount) =>
        compiledChildren.every(fn => fn(model, text, contentTypes, tokenCount))
    }
    return (model, text, contentTypes, tokenCount) =>
      compiledChildren.some(fn => fn(model, text, contentTypes, tokenCount))
  }

  /** 叶子条件 */
  const leaf = node as ConditionLeaf
  switch (leaf.type) {
    case "model": {
      if (!leaf.pattern || leaf.pattern === "*") return () => true
      const matcher = getCachedPicomatch(leaf.pattern)
      return (model) => matcher(model)
    }
    case "keyword": {
      const pattern = leaf.pattern
      return (_model, text) => text.includes(pattern)
    }
    case "regex": {
      const re = getCachedRegex(leaf.pattern, leaf.flags ?? "")
      return (_model, text) => re ? re.test(text) : false
    }
    case "content_type": {
      const pattern = leaf.pattern
      return (_model, _text, contentTypes) => contentTypes.has(pattern)
    }
    case "char_count": {
      const parsed = parseCharCountExpr(leaf.pattern)
      return (_model, _text, _contentTypes, tokenCount) => parsed(tokenCount)
    }
    default:
      return () => false
  }
}

/**
 * 预估文本的 token 数。
 *
 * 不依赖任何分词器，按字符类别加权估算，对中英文混合文本都给出合理近似：
 * - CJK（中日韩）字符：约 1 token/字（取保守上界，便于"小于 N 才路由"判定）
 * - 其他字符（含空格/标点）：约 4 字符/token（接近英文 BPE 平均比率）
 *
 * 相比直接用字符串长度（UTF-16 码元数），该估算对中文不再严重低估。
 */
export function estimateTokenCount(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    /** CJK 统一表意文字及扩展区、日文假名、韩文音节/谚文等 */
    if (
      (code >= 0x3000 && code <= 0x30ff) ||  // CJK 符号标点 + 日文假名
      (code >= 0x3400 && code <= 0x4dbf) ||  // CJK 扩展 A
      (code >= 0x4e00 && code <= 0x9fff) ||  // CJK 统一表意文字
      (code >= 0xac00 && code <= 0xd7af) ||  // 韩文音节
      (code >= 0xf900 && code <= 0xfaff) ||  // CJK 兼容表意
      (code >= 0xff00 && code <= 0xffef)     // 全角字符
    ) {
      cjk++
    } else {
      other++
    }
  }
  return cjk + Math.ceil(other / 4)
}

/** 解析 token 数比较表达式，返回求值函数 */
function parseCharCountExpr(pattern: string): (count: number) => boolean {
  const match = pattern.match(/^(<=?|>=?)\s*(\d+)$/)
  if (!match) return () => false
  const op = match[1]
  const threshold = parseInt(match[2]!, 10)
  switch (op) {
    case "<":  return (n) => n < threshold
    case "<=": return (n) => n <= threshold
    case ">":  return (n) => n > threshold
    case ">=": return (n) => n >= threshold
    default:   return () => false
  }
}

/** 从条件树中递归提取第一个 model 类型的 pattern */
function extractModelPatternFromTree(node?: ConditionNode): string | null {
  if (!node) return null
  if (node.type === "model") return (node as ConditionLeaf).pattern
  if (node.type === "and" || node.type === "or") {
    for (const child of (node as ConditionGroup).children) {
      const found = extractModelPatternFromTree(child)
      if (found) return found
    }
  }
  return null
}

import type { BalanceResult, QuotaResult, CurlQueryConfig, ProviderConfig, CurlUsageResult } from "../types.ts"
import { detectProvider, getBalanceEndpoint } from "./provider-detector.ts"

/** 查询超时毫秒数 */
const QUERY_TIMEOUT_MS = 5000

/**
 * 查询 provider 余额
 */
export async function queryProviderBalance(provider: ProviderConfig): Promise<BalanceResult> {
  const serviceType = detectProvider(provider.baseUrl)
  const endpoint = getBalanceEndpoint(serviceType, provider.baseUrl, provider.apiKey)
  if (!endpoint) {
    return { success: false, error: "不支持余额查询" }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS)

    const resp = await fetch(endpoint.url, {
      method: "GET",
      headers: endpoint.headers,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (resp.status === 401) {
      return { success: false, error: "API Key 无效或已过期" }
    }
    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status}` }
    }

    const data = await resp.json()

    switch (serviceType) {
      case "zhipu":
        return parseZhipuBalance(data)
      case "deepseek":
        return parseDeepSeekBalance(data)
      case "kimi":
        return parseKimiBalance(data)
      default:
        return { success: false, error: "未知服务商" }
    }
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { success: false, error: "查询超时" }
    }
    return { success: false, error: e instanceof Error ? e.message : "网络错误" }
  }
}

/**
 * 查询智谱用量限额
 */
export async function queryZhipuQuota(provider: ProviderConfig): Promise<QuotaResult> {
  const serviceType = detectProvider(provider.baseUrl)
  if (serviceType !== "zhipu") {
    return { success: false, error: "非智谱服务商" }
  }

  const isIntl = provider.baseUrl.toLowerCase().includes("z.ai")
  const host = isIntl ? "https://api.z.ai" : "https://open.bigmodel.cn"
  const url = `${host}/api/monitor/usage/quota/limit`

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS)

    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (resp.status === 401) {
      return { success: false, error: "API Key 无效或已过期" }
    }
    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status}` }
    }

    const data = await resp.json()
    return parseZhipuQuota(data)
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { success: false, error: "查询超时" }
    }
    return { success: false, error: e instanceof Error ? e.message : "网络错误" }
  }
}

/**
 * 用 cURL 配置查询，自动推断响应格式
 */
export async function queryWithCurl(config: CurlQueryConfig): Promise<BalanceResult | CurlUsageResult> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS)

    const resp = await fetch(config.url, {
      method: config.method,
      headers: config.headers,
      body: config.body,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (resp.status === 401) {
      return { success: false, error: "认证已过期，请重新导入 cURL" }
    }
    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status}` }
    }

    const data = await resp.json()

    /** 根据 URL 自动推断服务商类型 */
    const url = config.url.toLowerCase()
    if (url.includes("kimi.com")) {
      return parseKimiCurlUsage(data)
    }

    /** 通用余额解析：尝试常见字段路径 */
    return autoParseBalance(data)
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { success: false, error: "查询超时" }
    }
    return { success: false, error: e instanceof Error ? e.message : "网络错误" }
  }
}

/**
 * 解析 cURL 命令，提取 URL、method、headers、body
 */
export function parseCurl(curlString: string): {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
} {
  const result: {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  } = { url: "", method: "GET", headers: {} }

  const lines = curlString.replace(/\\\n/g, " ").split("\n")
  const singleLine = lines.join(" ")

  /** 提取 URL */
  const urlMatch = singleLine.match(/curl\s+['"]([^'"]+)['"]/)
  if (urlMatch) {
    result.url = urlMatch[1]!
  }

  /** 提取 -H / --header */
  const headerRegex = /-(?:H|header)\s+['"]([^:]+):\s*([^'"]+)['"]/g
  let headerMatch
  while ((headerMatch = headerRegex.exec(singleLine)) !== null) {
    const key = headerMatch[1]!.trim()
    const value = headerMatch[2]!.trim()
    result.headers[key] = value
  }

  /** 提取 -b / --cookie */
  const cookieMatch = singleLine.match(/-(?:b|cookie)\s+['"]([^'"]+)['"]/)
  if (cookieMatch) {
    result.headers["Cookie"] = cookieMatch[1]!
  }

  /** 提取 --data-raw / -d */
  const dataMatch = singleLine.match(/(?:--data-raw|-d)\s+['"]([\s\S]*?)['"]\s*(?:-|$)/)
  if (dataMatch) {
    result.body = dataMatch[1]!
    result.method = "POST"
  }

  /** 提取 -X method */
  const methodMatch = singleLine.match(/-X\s+(\w+)/)
  if (methodMatch) {
    result.method = methodMatch[1]!.toUpperCase()
  }

  /** 提取 connect-protocol-version */
  if (singleLine.includes("connect-protocol-version")) {
    const versionMatch = singleLine.match(/connect-protocol-version:\s*(\d+)/)
    if (versionMatch) {
      result.headers["connect-protocol-version"] = versionMatch[1]!
    }
  }

  return result
}

/**
 * 从 JSON 对象按点号路径提取值
 * 支持数组下标: "data.limits.0.percentage"
 */
export function extractValue(obj: unknown, path: string): unknown {
  if (!path) return obj
  const parts = path.split(".")
  let current: unknown = obj
  for (const part of parts) {
    if (current == null) return undefined
    const idx = Number(part)
    if (!Number.isNaN(idx) && Array.isArray(current)) {
      current = current[idx]
    } else if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

// ========== 自动解析 ==========

/**
 * 自动尝试常见余额字段路径
 */
function autoParseBalance(data: unknown): BalanceResult {
  const paths = [
    "data.available_balance",
    "data.balance",
    "available_balance",
    "balance",
    "data.total_balance",
    "total_balance",
  ]

  for (const path of paths) {
    const value = extractValue(data, path)
    if (value != null) {
      const balance = typeof value === "string" ? parseFloat(value) : Number(value)
      if (!Number.isNaN(balance)) {
        const currency = String(extractValue(data, "data.currency") ?? extractValue(data, "currency") ?? "CNY")
        return { success: true, balance, currency }
      }
    }
  }

  return { success: false, error: "无法识别余额字段，请检查响应格式" }
}

/**
 * 解析 Kimi cURL 返回的用量数据
 */
function parseKimiCurlUsage(data: unknown): CurlUsageResult {
  const d = data as Record<string, unknown>

  /** Kimi Code 返回: { usages: [{ scope, detail: { limit, used, remaining, resetTime }, limits: [{ window, detail }] }], totalQuota: { limit, remaining } } */
  const usages = d.usages as Array<Record<string, unknown>> | undefined
  if (Array.isArray(usages) && usages.length > 0) {
    const totalQuota = d.totalQuota as Record<string, unknown> | undefined

    return {
      success: true,
      provider: "kimi",
      usages: usages.map((u) => {
        const detail = u.detail as Record<string, unknown> | undefined
        const subLimits = u.limits as Array<Record<string, unknown>> | undefined

        return {
          scope: String(u.scope ?? "unknown"),
          limit: Number(detail?.limit ?? 0),
          used: Number(detail?.used ?? 0),
          remaining: Number(detail?.remaining ?? 0),
          resetTime: detail?.resetTime ? String(detail.resetTime) : undefined,
          subLimits: subLimits?.map((sl) => {
            const window = sl.window as Record<string, unknown> | undefined
            const slDetail = sl.detail as Record<string, unknown> | undefined
            const duration = Number(window?.duration ?? 0)
            const timeUnit = String(window?.timeUnit ?? "")
            const unitMap: Record<string, string> = { TIME_UNIT_MINUTE: "分钟", TIME_UNIT_HOUR: "小时", TIME_UNIT_DAY: "天" }
            return {
              window: `${duration}${unitMap[timeUnit] ?? timeUnit}`,
              limit: Number(slDetail?.limit ?? 0),
              used: Number(slDetail?.used ?? 0),
              remaining: Number(slDetail?.remaining ?? 0),
              resetTime: slDetail?.resetTime ? String(slDetail.resetTime) : undefined,
            }
          }),
        }
      }),
      totalQuota: totalQuota
        ? { limit: Number(totalQuota.limit ?? 0), remaining: Number(totalQuota.remaining ?? 0) }
        : undefined,
    }
  }

  /** 也尝试通用余额解析 */
  const balanceResult = autoParseBalance(data)
  if (balanceResult.success) {
    return { success: true, provider: "kimi" }
  }

  return { success: false, error: "无法识别 Kimi 响应格式" }
}

// ========== 各服务商响应解析 ==========

function parseZhipuBalance(data: unknown): BalanceResult {
  /** 智谱余额查询返回的是限额信息，余额需从其他端点或用户自行查看 */
  return { success: false, error: "智谱暂不支持余额查询，请查看限额" }
}

function parseZhipuQuota(data: unknown): QuotaResult {
  const d = data as Record<string, unknown>
  if (d.code !== 200 && d.success !== true) {
    return { success: false, error: (d.msg as string) || "查询失败" }
  }

  const dataObj = d.data as Record<string, unknown> | undefined
  const limits = dataObj?.limits as Array<Record<string, unknown>> | undefined

  if (!Array.isArray(limits)) {
    return { success: false, error: "响应格式异常" }
  }

  return {
    success: true,
    limits: limits.map((l) => ({
      type: String(l.type ?? ""),
      percentage: Number(l.percentage ?? 0),
      usage: l.usage != null ? Number(l.usage) : undefined,
      currentValue: l.currentValue != null ? Number(l.currentValue) : undefined,
      remaining: l.remaining != null ? Number(l.remaining) : undefined,
      unit: l.unit != null ? Number(l.unit) : undefined,
      number: l.number != null ? Number(l.number) : undefined,
    })),
  }
}

function parseDeepSeekBalance(data: unknown): BalanceResult {
  const d = data as Record<string, unknown>
  const infos = d.balance_infos as Array<Record<string, unknown>> | undefined

  if (!Array.isArray(infos) || infos.length === 0) {
    return { success: false, error: "响应格式异常" }
  }

  const info = infos[0]!
  const balanceRaw = info.total_balance
  const balance = typeof balanceRaw === "string" ? parseFloat(balanceRaw) : Number(balanceRaw)
  const currency = String(info.currency ?? "CNY")

  const grantedRaw = info.granted_balance
  const grantedBalance = typeof grantedRaw === "string" ? parseFloat(grantedRaw) : typeof grantedRaw === "number" ? grantedRaw : undefined

  const toppedUpRaw = info.topped_up_balance
  const toppedUpBalance = typeof toppedUpRaw === "string" ? parseFloat(toppedUpRaw) : typeof toppedUpRaw === "number" ? toppedUpRaw : undefined

  if (Number.isNaN(balance)) {
    return { success: false, error: "余额格式异常" }
  }

  return { success: true, balance, currency, grantedBalance, toppedUpBalance }
}

function parseKimiBalance(data: unknown): BalanceResult {
  const d = data as Record<string, unknown>
  const dataObj = d.data as Record<string, unknown> | undefined

  if (!dataObj) {
    return { success: false, error: "响应格式异常" }
  }

  const balanceRaw = dataObj.available_balance ?? dataObj.total_balance
  const balance = typeof balanceRaw === "string" ? parseFloat(balanceRaw) : Number(balanceRaw)
  const currency = String(dataObj.currency ?? "CNY")

  const voucherRaw = dataObj.voucher_balance
  const grantedBalance = typeof voucherRaw === "string" ? parseFloat(voucherRaw) : typeof voucherRaw === "number" ? voucherRaw : undefined

  const cashRaw = dataObj.cash_balance
  const toppedUpBalance = typeof cashRaw === "string" ? parseFloat(cashRaw) : typeof cashRaw === "number" ? cashRaw : undefined

  if (Number.isNaN(balance)) {
    return { success: false, error: "余额格式异常" }
  }

  return { success: true, balance, currency, grantedBalance, toppedUpBalance }
}

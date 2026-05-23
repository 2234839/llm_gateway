import type { ServiceProvider } from "../types.ts"

/**
 * 根据 baseUrl 自动推导服务商类型
 */
export function detectProvider(baseUrl: string): ServiceProvider {
  const url = baseUrl.toLowerCase()
  if (url.includes("bigmodel.cn") || url.includes("z.ai")) return "zhipu"
  if (url.includes("deepseek.com")) return "deepseek"
  if (url.includes("moonshot.cn") || url.includes("moonshot.ai")) return "kimi"
  return "unknown"
}

/**
 * 获取服务商显示名称
 */
export function getProviderDisplayName(provider: ServiceProvider): string {
  const names: Record<ServiceProvider, string> = {
    zhipu: "智谱 GLM",
    deepseek: "DeepSeek",
    kimi: "Kimi",
    unknown: "其他",
  }
  return names[provider] ?? "其他"
}

/**
 * 获取服务商余额查询端点配置
 */
export function getBalanceEndpoint(
  provider: ServiceProvider,
  baseUrl: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } | null {
  const authHeader = { Authorization: `Bearer ${apiKey}` }

  switch (provider) {
    case "zhipu": {
      const isIntl = baseUrl.toLowerCase().includes("z.ai")
      const host = isIntl ? "https://api.z.ai" : "https://open.bigmodel.cn"
      return {
        url: `${host}/api/monitor/usage/quota/limit`,
        headers: authHeader,
      }
    }
    case "deepseek": {
      return {
        url: "https://api.deepseek.com/user/balance",
        headers: authHeader,
      }
    }
    case "kimi": {
      return {
        url: "https://api.moonshot.cn/v1/users/me/balance",
        headers: authHeader,
      }
    }
    default:
      return null
  }
}

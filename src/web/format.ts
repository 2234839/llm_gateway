/** 格式化请求耗时 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  let m = Math.floor(ms / 60_000)
  let s = Math.round((ms % 60_000) / 1000)
  if (s === 60) { m++; s = 0 }
  return `${m}m${s}s`
}

/** 格式化数字（token 数等） */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** 格式化 Token 总量 */
export function formatTokenCount(stats: { inputTokens: number; outputTokens: number; cacheCreationTokens?: number; cacheReadTokens?: number } | undefined): string {
  if (!stats) return "0"
  const total = stats.inputTokens + stats.outputTokens + (stats.cacheCreationTokens ?? 0) + (stats.cacheReadTokens ?? 0)
  return formatNumber(total)
}

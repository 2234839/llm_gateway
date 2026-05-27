/** 20 色调色板 — 用于 provider 图表显示 */
const PALETTE = [
  "#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4",
  "#a855f7", "#ec4899", "#14b8a6", "#f97316", "#8b5cf6",
  "#10b981", "#e11d48", "#0ea5e9", "#d946ef", "#84cc16",
  "#f43f5e", "#6d28d9", "#059669", "#dc2626", "#7c3aed",
]

/** 基于 key 的确定性 hash 从调色板中选色 */
export function getStableColor(key: string): string {
  let hash = 0
  for (const ch of key) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  return PALETTE[Math.abs(hash) % PALETTE.length]!
}

/** 生成一个随机 HEX 颜色 */
export function randomColor(): string {
  return "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")
}

/** 生成 API Key 并计算哈希 */
export function generateApiKey(): { rawKey: string; hash: string; prefix: string } {
  /** sk- 前缀 + 32 位随机字符 */
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let random = ""
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  for (const b of bytes) {
    random += chars[b % chars.length]
  }
  const rawKey = `sk-${random}`
  const hash = new Bun.CryptoHasher("sha256").update(rawKey).digest("hex")
  const prefix = rawKey.slice(0, 8)
  return { rawKey, hash, prefix }
}

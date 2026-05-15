/** 生成 API Key 并计算哈希 */
export function generateApiKey(): { rawKey: string; hash: string; prefix: string } {
  /** sk- 前缀 + 32 位随机字符 */
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  const charLen = chars.length
  /** 拒绝采样上限：排除会导致模偏差的尾部字节 */
  const rejectBound = 256 - (256 % charLen)
  let random = ""
  while (random.length < 32) {
    const bytes = crypto.getRandomValues(new Uint8Array(48))
    for (const b of bytes) {
      if (b < rejectBound) {
        random += chars[b % charLen]
        if (random.length >= 32) break
      }
    }
  }
  const rawKey = `sk-${random}`
  const hash = new Bun.CryptoHasher("sha256").update(rawKey).digest("hex")
  const prefix = rawKey.slice(0, 8)
  return { rawKey, hash, prefix }
}

/** 词级 diff 片段 */
export interface DiffSpan {
  text: string
  type: "same" | "add" | "del"
}

/** 单行内词级 diff：按空白拆 token 求 LCS，标记新增/删除；token 乘积过大时退化为整块替换 */
function diffTokens(before: string, after: string, push: (text: string, type: DiffSpan["type"]) => void): void {
  const tokenize = (s: string) => s.split(/(\s+)/).filter(t => t !== "")
  const a = tokenize(before)
  const b = tokenize(after)

  if (a.length * b.length > 4_000_000) {
    if (before) push(before, "del")
    if (after) push(after, "add")
    return
  }

  /** dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度 */
  const dp: Int32Array[] = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push(a[i]!, "same"); i++; j++ }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { push(a[i]!, "del"); i++ }
    else { push(b[j]!, "add"); j++ }
  }
  while (i < a.length) { push(a[i]!, "del"); i++ }
  while (j < b.length) { push(b[j]!, "add"); j++ }
}

/**
 * 两级 diff：先按行求 LCS（大文本中未变化的行直接原样保留），
 * 再把连续的删/增行按顺序配对做词级高亮 —— 避免大文本整块红绿。
 */
export function diffWords(before: string, after: string): DiffSpan[] {
  if (before === after) return []

  const a = before.split("\n")
  const b = after.split("\n")

  /** 行数乘积过大时退化为整块删除+整块新增（极端防御） */
  if (a.length * b.length > 4_000_000) {
    return [
      ...(before ? [{ text: before, type: "del" as const }] : []),
      ...(after ? [{ text: after, type: "add" as const }] : []),
    ]
  }

  /** dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度 */
  const dp: Int32Array[] = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const spans: DiffSpan[] = []
  const push = (text: string, type: DiffSpan["type"]) => {
    const last = spans[spans.length - 1]
    if (last && last.type === type) last.text += text
    else spans.push({ text, type })
  }

  /** 连续的删/增行缓冲，flush 时按序配对做词级 diff */
  let delBuf: string[] = []
  let addBuf: string[] = []
  const flush = () => {
    if (delBuf.length === 0 && addBuf.length === 0) return
    const pairs = Math.min(delBuf.length, addBuf.length)
    for (let k = 0; k < pairs; k++) {
      diffTokens(delBuf[k]! + "\n", addBuf[k]! + "\n", push)
    }
    if (delBuf.length > pairs) push(delBuf.slice(pairs).join("\n") + "\n", "del")
    if (addBuf.length > pairs) push(addBuf.slice(pairs).join("\n") + "\n", "add")
    delBuf = []
    addBuf = []
  }

  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      flush()
      push(a[i]! + "\n", "same")
      i++; j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      delBuf.push(a[i]!)
      i++
    } else {
      addBuf.push(b[j]!)
      j++
    }
  }
  while (i < a.length) { delBuf.push(a[i]!); i++ }
  while (j < b.length) { addBuf.push(b[j]!); j++ }
  flush()

  /** 最后一个 span 可能带多余的尾部换行（diff 逐行补的），修剪一个 */
  const last = spans[spans.length - 1]
  if (last && last.text.endsWith("\n")) last.text = last.text.slice(0, -1)

  /** 纯空白的 same 片段若紧邻删除片段，并入删除显示 —— 删除的词连同其换行一起带删除线，避免残留空行观感 */
  const merged: DiffSpan[] = []
  for (const span of spans) {
    const prev = merged[merged.length - 1]
    if (span.type === "same" && span.text.trim() === "" && prev?.type === "del") {
      prev.text += span.text
    } else {
      merged.push({ ...span })
    }
  }
  return merged
}

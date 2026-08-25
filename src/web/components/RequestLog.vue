<script setup lang="ts">
import { ref, onMounted, onUnmounted, onActivated, onDeactivated } from "vue"
import { logApi, providerApi, apiKeyApi, keyGroupApi, type LogEntry, type LogMessageInfo, type TopMessageInfo, type ProviderInfo, type ApiKeyInfo, type KeyGroupInfo } from "../api"
import { t } from "../i18n"
import { formatDuration, formatNumber } from "../format"
import { diffWords, type DiffSpan } from "../utils/diff"
import { subscribeSSE } from "../sse-manager"

const logs = ref<LogEntry[]>([])
const providers = ref<ProviderInfo[]>([])
const apiKeys = ref<ApiKeyInfo[]>([])
const keyGroups = ref<KeyGroupInfo[]>([])
const loading = ref(true)
const loadError = ref("")
const offset = ref(0)
const limit = 50
const hasMore = ref(true)
const expandedId = ref<number | null>(null)

/** 复制成功提示：显示后自动消失 */
const copyToast = ref("")
let copyToastTimer: ReturnType<typeof setTimeout> | null = null
/** 筛选条件 */
const filterModel = ref("")
const filterStatus = ref("")
const filterProvider = ref("")
const filterKey = ref("")
const filterGroup = ref("")
const filterFallback = ref(false)
const filterStartTime = ref("")
const filterEndTime = ref("")

/** 排序：列名 + 方向 */
const sortField = ref("")
const sortDir = ref<"asc" | "desc">("desc")

/** 点击表头切换排序 */
function toggleSort(field: string) {
  if (sortField.value === field) {
    sortDir.value = sortDir.value === "desc" ? "asc" : "desc"
  } else {
    sortField.value = field
    sortDir.value = "desc"
  }
  applyFilters()
}

/** 构建排序参数 */
function sortParam(): string {
  if (!sortField.value) return ""
  return `${sortField.value}_${sortDir.value}`
}

/** 排序列的指示器 */
function sortIndicator(field: string): string {
  if (sortField.value !== field) return ""
  return sortDir.value === "desc" ? " ▼" : " ▲"
}

/** 自动刷新开关（默认关闭，用户手动勾选后启用） */
const autoRefresh = ref(false)
/** SSE 实时刷新 */
let sseUnsubscribe: (() => void) | null = null
/** 防抖：避免短时间内多个请求结束触发频繁刷新 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null

function connectSSE() {
  disconnectSSE()
  sseUnsubscribe = subscribeSSE((event) => {
    if (event.type === "request_end") {
      scheduleRefresh()
    }
  })
}

function disconnectSSE() {
  if (sseUnsubscribe) { sseUnsubscribe(); sseUnsubscribe = null }
}

/** 仅在自动刷新开启 + 第一页 + 无筛选条件时刷新 */
function scheduleRefresh() {
  if (!autoRefresh.value) return
  if (offset.value > 0 || filterModel.value || filterStatus.value || filterProvider.value || filterKey.value || filterGroup.value || filterFallback.value || filterStartTime.value || filterEndTime.value) return
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    load()
  }, 2000)
}

/** 自动刷新开关变化时连接/断开 SSE */
function onAutoRefreshChange() {
  if (autoRefresh.value) {
    connectSSE()
  } else {
    disconnectSSE()
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
  }
}

onMounted(async () => {
  const [p, k, g] = await Promise.all([providerApi.list(), apiKeyApi.list(), keyGroupApi.list()])
  providers.value = p
  apiKeys.value = k
  keyGroups.value = g
  await load()
  /** 默认不连接 SSE，用户勾选自动刷新后才连接 */
})

onUnmounted(() => {
  disconnectSSE()
  if (refreshTimer) clearTimeout(refreshTimer)
  if (copyToastTimer) clearTimeout(copyToastTimer)
})

/** KeepAlive deactivate：暂停 SSE 以节省资源 */
onDeactivated(() => {
  disconnectSSE()
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
})

/** KeepAlive activate：恢复 SSE（仅自动刷新开启时） */
onActivated(() => {
  if (autoRefresh.value) connectSSE()
})

async function load() {
  loading.value = true
  const params: { limit: number; offset: number; model?: string; providerId?: string; apiKeyId?: string; groupId?: string; status?: string; startTime?: string; endTime?: string; hasFallback?: boolean } = { limit: limit + 1, offset: offset.value }
  if (filterModel.value) params.model = filterModel.value
  if (filterProvider.value) params.providerId = filterProvider.value
  if (filterKey.value) params.apiKeyId = filterKey.value
  if (filterGroup.value) params.groupId = filterGroup.value
  if (filterStatus.value) params.status = filterStatus.value
  if (filterFallback.value) params.hasFallback = true
  if (filterStartTime.value) params.startTime = new Date(filterStartTime.value).toISOString().replace("T", " ").slice(0, 19)
  if (filterEndTime.value) params.endTime = new Date(filterEndTime.value).toISOString().replace("T", " ").slice(0, 19)
  try {
    const result = await logApi.list({ ...params, sort: sortParam() || undefined })
    /** 多取一条判断是否还有更多数据 */
    if (result.length > limit) {
      logs.value = result.slice(0, limit)
      hasMore.value = true
    } else {
      logs.value = result
      hasMore.value = false
    }
    loadError.value = ""
  } catch (e) {
    if (logs.value.length === 0) {
      loadError.value = e instanceof Error ? e.message : "Failed to load logs"
    }
  }
  loading.value = false
}

function applyFilters() {
  expandedId.value = null
  offset.value = 0
  load()
}

function clearFilters() {
  filterModel.value = ""
  filterStatus.value = ""
  filterProvider.value = ""
  filterKey.value = ""
  filterGroup.value = ""
  filterFallback.value = false
  filterStartTime.value = ""
  filterEndTime.value = ""
  activeQuickRange.value = ""
  sortField.value = ""
  sortDir.value = "desc"
  offset.value = 0
  load()
}

/** 当前活跃的快捷范围 */
const activeQuickRange = ref("")

/** 将 Date 转为 datetime-local 格式 */
function toLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function setQuickRange(range: string) {
  if (activeQuickRange.value === range) {
    activeQuickRange.value = ""
    filterStartTime.value = ""
    filterEndTime.value = ""
  } else {
    activeQuickRange.value = range
    const now = new Date()
    filterEndTime.value = toLocalDatetime(now)
    const ms: Record<string, number> = { "1h": 3600_000, "24h": 86400_000, "7d": 604800_000, "30d": 2592000_000 }
    filterStartTime.value = toLocalDatetime(new Date(now.getTime() - (ms[range] ?? 0)))
  }
  applyFilters()
}

function isQuickRange(range: string): boolean {
  return activeQuickRange.value === range
}

async function prev() {
  expandedId.value = null
  offset.value = Math.max(0, offset.value - limit)
  await load()
}

async function next() {
  expandedId.value = null
  offset.value += limit
  await load()
}

function formatTime(ts: string): string {
  return new Date(ts + "Z").toLocaleString()
}

function statusClass(code: number): string {
  if (code >= 200 && code < 300) return "status-ok"
  if (code >= 400) return "status-err"
  return ""
}

/** 按需加载的 content 缓存：logId -> { inputContent, outputContent }，最多保留 30 条 */
const MAX_CONTENT_CACHE = 30
const contentCache = new Map<number, { inputContent: string | null; outputContent: string | null; inputMessages?: LogMessageInfo[]; rewriteDiffs?: string | null }>()
/** 正在加载的 log id 集合 */
const loadingContent = ref<Set<number>>(new Set())

async function toggleExpand(id: number) {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  expandedId.value = id
  /** 如果本地没有 content 且尚未加载过，按需请求 */
  if (!contentCache.has(id)) {
    loadingContent.value = new Set([...loadingContent.value, id])
    try {
      const detail = await logApi.detail(id)
      contentCache.set(id, { inputContent: detail.inputContent, outputContent: detail.outputContent, inputMessages: detail.inputMessages, rewriteDiffs: detail.rewriteDiffs })
      messageViewCache.delete(id)
      /** 淘汰最旧的缓存条目 */
      if (contentCache.size > MAX_CONTENT_CACHE) {
        const firstKey = contentCache.keys().next().value
        if (firstKey !== undefined) {
          contentCache.delete(firstKey)
          messageViewCache.delete(firstKey)
        }
      }
    } catch { /* 加载失败，静默处理 */ }
    loadingContent.value = new Set([...loadingContent.value].filter(i => i !== id))
  }
}

/** 获取缓存的 content */
function getContent(id: number): { inputContent: string | null; outputContent: string | null; inputMessages?: LogMessageInfo[]; rewriteDiffs?: string | null } {
  return contentCache.get(id) ?? { inputContent: null, outputContent: null }
}

/** 高频消息面板 */
const showTopMessages = ref(false)
const topMessages = ref<TopMessageInfo[]>([])
const topMessagesLoading = ref(false)
const topMessagesBy = ref<"bytes" | "refs">("bytes")

async function loadTopMessages() {
  topMessagesLoading.value = true
  try {
    topMessages.value = await logApi.topMessages(20, topMessagesBy.value)
  } catch { /* silent */ }
  topMessagesLoading.value = false
}

function toggleTopMessages() {
  showTopMessages.value = !showTopMessages.value
  if (showTopMessages.value && !topMessages.value.length) void loadTopMessages()
}

function switchTopMessagesBy(by: "bytes" | "refs") {
  if (topMessagesBy.value === by) return
  topMessagesBy.value = by
  void loadTopMessages()
}

/** 收起的输入消息序号集合：log id → 消息序号集合（默认展开，点 header 收起） */
const collapsedMessages = ref<Map<number, Set<number>>>(new Map())

function toggleMessage(logId: number, seq: number) {
  const set = collapsedMessages.value.get(logId) ?? new Set<number>()
  if (set.has(seq)) set.delete(seq)
  else set.add(seq)
  collapsedMessages.value.set(logId, set)
  collapsedMessages.value = new Map(collapsedMessages.value)
}

function isMessageExpanded(logId: number, seq: number): boolean {
  return !collapsedMessages.value.get(logId)?.has(seq)
}

/** 消息角色标签颜色 */
function roleClass(role: string): string {
  if (role === "system") return "role-system"
  if (role === "user") return "role-user"
  if (role === "assistant") return "role-assistant"
  if (role.startsWith("tool:")) return "role-other"
  return "role-other"
}

/** 人性化字节大小 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** 尝试 JSON pretty-print，失败则原样返回（超过 100KB 跳过解析避免卡顿） */
function formatContent(text: string | null): string {
  if (!text) return ""
  if (text.length > 100_000) return text
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}

/** 格式化 fallback 尝试信息为可读文本 */
function formatFallbackAttempts(raw: string | null): string {
  if (!raw) return ""
  try {
    const attempts = JSON.parse(raw)
    if (!Array.isArray(attempts)) return raw
    return attempts.map((a: { providerId?: string; providerName?: string; model?: string; targetModel?: string; error?: string; statusCode?: number }, i: number) =>
      `#${i + 1} ${a.providerName ?? a.providerId ?? "unknown"}${a.targetModel ? ` → ${a.targetModel}` : ""}${a.statusCode ? ` [${a.statusCode}]` : ""}${a.error ? `: ${a.error}` : ""}`
    ).join("\n")
  } catch {
    return raw
  }
}

/** 解析命中的内容改写规则名列表 */
function parseMatchedRewrites(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(n => typeof n === "string") : []
  } catch {
    return []
  }
}

/** 单条消息的改写差异（改写前/后快照，带快照序号） */
interface RewriteDiffInfo {
  idx: number
  role: string
  before: string
  after: string
}

/** 解析日志中存储的消息级改写差异 */
function parseRewriteDiffs(raw: string | null): RewriteDiffInfo[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((d): d is RewriteDiffInfo =>
      typeof d === "object" && d !== null && typeof (d as RewriteDiffInfo).before === "string" && typeof (d as RewriteDiffInfo).after === "string" && typeof (d as RewriteDiffInfo).idx === "number")
  } catch {
    return []
  }
}

/** 展开了工具声明组的日志 id 集合（默认收起） */
const expandedTools = ref<Set<number>>(new Set())

/** 切换某条日志的工具声明组展开状态 */
function toggleTools(logId: number) {
  const next = new Set(expandedTools.value)
  if (next.has(logId)) next.delete(logId)
  else next.add(logId)
  expandedTools.value = next
}

/** 消息视图缓存：按日志 id 缓存一次性的分组与 diff 解析结果，避免模板每张卡片重复计算（大日志会卡死页面） */
interface MessageView {
  /** 工具声明条目（带原始序号） */
  tools: { msg: LogMessageInfo; idx: number }[]
  /** 对话消息条目（带原始序号） */
  msgs: { msg: LogMessageInfo; idx: number }[]
  /** 序号 → 改写差异 */
  diffMap: Map<number, RewriteDiffInfo>
  /** 序号 → 词级 diff 片段（懒计算，展开时才算且只算一次） */
  spansMap: Map<number, DiffSpan[]>
}
const messageViewCache = new Map<number, MessageView>()

/** 获取（或构建）某条日志的消息视图：工具/消息分组 + diff 解析只做一次 */
function messageView(logId: number): MessageView {
  const cached = messageViewCache.get(logId)
  if (cached) return cached
  const source = contentCache.get(logId)?.inputMessages ?? []
  const view: MessageView = {
    tools: [],
    msgs: [],
    diffMap: new Map(parseRewriteDiffs(contentCache.get(logId)?.rewriteDiffs ?? null).map(d => [d.idx, d])),
    spansMap: new Map(),
  }
  source.forEach((msg, idx) => {
    if (msg.role.startsWith("tool:")) view.tools.push({ msg, idx })
    else view.msgs.push({ msg, idx })
  })
  messageViewCache.set(logId, view)
  return view
}

/** 计算并缓存某条日志中指定序号消息的词级 diff 片段（Git diff 式高亮，只算一次） */
function diffSpans(logId: number, idx: number, d: RewriteDiffInfo): DiffSpan[] {
  const view = messageView(logId)
  const cached = view.spansMap.get(idx)
  if (cached) return cached
  const spans = d.before === d.after ? [] : diffWords(d.before, d.after)
  view.spansMap.set(idx, spans)
  return spans
}

/** 复制文本到剪贴板，成功后显示 toast 提示 */
async function copyContent(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.style.position = "fixed"
    ta.style.opacity = "0"
    document.body.appendChild(ta)
    try {
      ta.select()
      document.execCommand("copy")
    } finally {
      document.body.removeChild(ta)
    }
  }
  copyToast.value = "Copied!"
  if (copyToastTimer) clearTimeout(copyToastTimer)
  copyToastTimer = setTimeout(() => { copyToast.value = "" }, 1500)
}
</script>

<template>
  <div class="request-log">
    <div v-if="copyToast" class="copy-toast">{{ copyToast }}</div>
    <div class="toolbar">
      <h2>{{ t('log.title') }}</h2>
      <button class="btn" @click="toggleTopMessages">{{ t('log.topMessages') }}</button>
      <button class="btn" @click="load">{{ t('log.refresh') }}</button>
      <label class="filter-checkbox auto-refresh-toggle">
        <input type="checkbox" v-model="autoRefresh" @change="onAutoRefreshChange" />
        {{ t('log.autoRefresh') }}
      </label>
    </div>

    <!-- 高频消息面板：消息块引用统计 -->
    <div v-if="showTopMessages" class="top-messages-panel">
      <div class="top-messages-header">
        <strong>{{ t('log.topMessages') }}</strong>
        <div class="top-messages-sort">
          <button :class="['btn-sm', { active: topMessagesBy === 'bytes' }]" @click="switchTopMessagesBy('bytes')">{{ t('log.sortByBytes') }}</button>
          <button :class="['btn-sm', { active: topMessagesBy === 'refs' }]" @click="switchTopMessagesBy('refs')">{{ t('log.sortByRefs') }}</button>
        </div>
        <button class="btn-sm" @click="showTopMessages = false">&times;</button>
      </div>
      <div v-if="topMessagesLoading" class="top-messages-empty">{{ t('log.loading') }}</div>
      <div v-else-if="!topMessages.length" class="top-messages-empty">{{ t('log.noTopMessages') }}</div>
      <div v-else class="top-messages-list">
        <div v-for="(m, i) in topMessages" :key="m.hash" class="top-message-item">
          <span class="top-message-rank">#{{ i + 1 }}</span>
          <span class="message-role" :class="roleClass(m.role)">{{ m.role }}</span>
          <span class="top-message-stats">
            <span class="chip-add">×{{ m.hitCount }}</span>
            <span class="top-message-size">{{ formatSize(m.size) }} / {{ formatSize(m.size * m.hitCount) }}</span>
          </span>
          <pre class="top-message-preview">{{ m.content.slice(0, 300) }}{{ m.content.length > 300 ? '...' : '' }}</pre>
        </div>
      </div>
    </div>

    <!-- 筛选栏 -->
    <div class="filter-bar">
      <input
        v-model="filterModel"
        :placeholder="t('log.filterModel')"
        class="filter-input"
        @keydown.enter="applyFilters"
      />
      <select v-model="filterProvider" class="filter-select" @change="applyFilters">
        <option value="">{{ t('log.allProviders') }}</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <select v-model="filterGroup" class="filter-select" @change="applyFilters">
        <option value="">{{ t('log.allGroups') }}</option>
        <option v-for="g in keyGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
      </select>
      <select v-model="filterKey" class="filter-select" @change="applyFilters">
        <option value="">{{ t('log.allKeys') }}</option>
        <option v-for="k in apiKeys" :key="k.id" :value="k.id">{{ k.name }}</option>
      </select>
      <select v-model="filterStatus" class="filter-select" @change="applyFilters">
        <option value="">{{ t('log.allStatus') }}</option>
        <option value="error">{{ t('log.errorOnly') }}</option>
        <option value="2">2xx (OK)</option>
        <option value="4">4xx (Client Error)</option>
        <option value="5">5xx (Server Error)</option>
      </select>
      <label class="filter-checkbox">
        <input type="checkbox" v-model="filterFallback" @change="applyFilters" /> FB
      </label>
      <input type="datetime-local" v-model="filterStartTime" class="filter-input filter-time" @change="applyFilters" />
      <span class="time-sep">~</span>
      <input type="datetime-local" v-model="filterEndTime" class="filter-input filter-time" @change="applyFilters" />
      <button class="btn btn-sm" @click="applyFilters">{{ t('log.applyFilter') }}</button>
      <button class="btn btn-sm" @click="clearFilters">{{ t('log.clearFilter') }}</button>
    </div>
    <div class="quick-time-bar">
      <button :class="['btn', 'btn-sm', { active: isQuickRange('1h') }]" @click="setQuickRange('1h')">1h</button>
      <button :class="['btn', 'btn-sm', { active: isQuickRange('24h') }]" @click="setQuickRange('24h')">24h</button>
      <button :class="['btn', 'btn-sm', { active: isQuickRange('7d') }]" @click="setQuickRange('7d')">7d</button>
      <button :class="['btn', 'btn-sm', { active: isQuickRange('30d') }]" @click="setQuickRange('30d')">30d</button>
    </div>

    <div v-if="loading" class="loading">{{ t('log.loading') }}</div>

    <div v-else-if="loadError" class="error-banner">{{ loadError }}</div>

    <div v-else>
      <table class="table">
        <thead>
          <tr>
            <th class="sortable" @click="toggleSort('time')">{{ t('log.timeCol') }}{{ sortIndicator('time') }}</th>
            <th>{{ t('log.modelCol') }}</th>
            <th>{{ t('log.providerCol') }}</th>
            <th>{{ t('log.targetModelCol') }}</th>
            <th>{{ t('log.keyCol') }}</th>
            <th>{{ t('log.streamCol') }}</th>
            <th class="sortable" @click="toggleSort('status')">{{ t('log.statusCol') }}{{ sortIndicator('status') }}</th>
            <th class="sortable" @click="toggleSort('duration')">{{ t('log.durationCol') }}{{ sortIndicator('duration') }}</th>
            <th>{{ t('log.tokensCol') }}</th>
            <th>{{ t('log.errorCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="log in logs" :key="log.id">
            <tr class="log-row" @click="toggleExpand(log.id)">
              <td class="mono">{{ formatTime(log.timestamp) }}</td>
              <td><code>{{ log.model }}</code></td>
              <td>{{ log.providerName }}<span v-if="log.fallbackAttempts" class="fallback-badge" :title="log.fallbackAttempts">FB</span><span v-if="log.matchedRewriteRules" class="rewrite-badge" :title="log.matchedRewriteRules">RW</span></td>
              <td><code>{{ log.targetModel }}</code></td>
              <td>{{ log.keyName || '-' }}</td>
              <td>{{ log.stream ? t('log.yes') : t('log.no') }}</td>
              <td :class="statusClass(log.statusCode)">{{ log.statusCode }}</td>
              <td>{{ formatDuration(log.durationMs) }}</td>
              <td :title="`Input: ${log.inputTokens}\nOutput: ${log.outputTokens}\nCache Read: ${log.cacheReadTokens}\nCache Write: ${log.cacheCreationTokens}`">{{ formatNumber(log.inputTokens + log.outputTokens) }}<template v-if="log.cacheReadTokens > 0 || log.cacheCreationTokens > 0"> <span class="cache-hint" :title="`Cache R: ${formatNumber(log.cacheReadTokens)}, W: ${formatNumber(log.cacheCreationTokens)}`">C</span></template></td>
              <td class="error-text" :title="log.error ?? undefined">{{ log.error ? log.error.slice(0, 50) : "-" }}</td>
            </tr>
            <tr v-if="expandedId === log.id" class="expand-row">
              <td colspan="10">
                <div class="expand-content">
                  <div v-if="loadingContent.has(log.id)" class="content-block">
                    <div class="content-label">{{ t('log.loading') }}</div>
                  </div>
                  <template v-else>
                  <div class="detail-summary">
                    <span><span class="detail-label">Status</span> <span :class="statusClass(log.statusCode)">{{ log.statusCode }}</span></span>
                    <span><span class="detail-label">{{ t('log.durationCol') }}</span> {{ formatDuration(log.durationMs) }}</span>
                    <span v-if="log.inputTokens || log.outputTokens"><span class="detail-label">{{ t('dashboard.inputCol') }}</span> {{ formatNumber(log.inputTokens) }}</span>
                    <span v-if="log.inputTokens || log.outputTokens"><span class="detail-label">{{ t('dashboard.outputCol') }}</span> {{ formatNumber(log.outputTokens) }}</span>
                    <span v-if="log.cacheReadTokens"><span class="detail-label">{{ t('dashboard.cacheReadCol') }}</span> {{ formatNumber(log.cacheReadTokens) }}</span>
                    <span v-if="log.cacheCreationTokens"><span class="detail-label">{{ t('dashboard.cacheWriteCol') }}</span> {{ formatNumber(log.cacheCreationTokens) }}</span>
                  </div>
                  <div v-if="log.error" class="content-block">
                    <div class="content-label error-text">{{ t('log.errorCol') }}</div>
                    <pre class="content-text error-text">{{ log.error }}</pre>
                  </div>
                  <div v-if="log.fallbackAttempts" class="content-block">
                    <div class="content-label">{{ t('log.fallbackAttempts') }}</div>
                    <pre class="content-text">{{ formatFallbackAttempts(log.fallbackAttempts) }}</pre>
                  </div>
                  <div v-if="log.matchedRewriteRules && parseMatchedRewrites(log.matchedRewriteRules).length" class="content-block">
                    <div class="content-label">{{ t('log.matchedRewriteRules') }}</div>
                    <div class="rewrite-rule-tags">
                      <span v-for="name in parseMatchedRewrites(log.matchedRewriteRules)" :key="name" class="rewrite-rule-tag">{{ name }}</span>
                    </div>
                  </div>
                  <!-- 改写差异：Git diff 式词级高亮，内联在对应消息卡片上（数据来自按需加载的日志详情） -->
                  <!-- 输入：消息数组渲染（消息块去重存储） -->
                  <div v-if="getContent(log.id).inputMessages?.length" class="content-block">
                    <div class="content-label">{{ t('log.prompt') }} <button class="btn-copy" @click.stop="copyContent(getContent(log.id).inputMessages!.map(m => m.content).join('\n'))">{{ t('log.copy') }}</button></div>
                    <div class="message-list">
                      <!-- 工具声明：整体折叠为一组卡片，默认收起 -->
                      <div v-if="messageView(log.id).tools.length" class="tools-group">
                        <div class="tools-group-header" @click="toggleTools(log.id)">
                          <span class="message-role role-other">{{ t('log.toolsGroup', { n: messageView(log.id).tools.length }) }}</span>
                          <span class="message-toggle">{{ expandedTools.has(log.id) ? '▾' : '▸' }}</span>
                        </div>
                        <template v-if="expandedTools.has(log.id)">
                          <div v-for="e in messageView(log.id).tools" :key="e.msg.hash + e.idx" class="message-card" :class="{ rewritten: messageView(log.id).diffMap.has(e.idx) }">
                            <div class="message-header" @click="toggleMessage(log.id, e.idx)">
                              <span class="message-role" :class="roleClass(e.msg.role)">{{ e.msg.role }}</span>
                              <span v-if="messageView(log.id).diffMap.has(e.idx)" class="message-rewritten-badge">{{ t('log.rewritten') }}</span>
                              <span v-if="e.msg.hitCount > 1" class="message-hits" :title="t('log.messageHitsTitle')">{{ t('log.messageHits', { n: e.msg.hitCount }) }}</span>
                              <span class="message-size">{{ formatSize(e.msg.content.length) }}</span>
                              <span class="message-toggle">{{ isMessageExpanded(log.id, e.idx) ? '▾' : '▸' }}</span>
                            </div>
                            <pre v-if="isMessageExpanded(log.id, e.idx) && messageView(log.id).diffMap.has(e.idx)" class="message-content diff"><template v-for="(s, si) in diffSpans(log.id, e.idx, messageView(log.id).diffMap.get(e.idx)!)" :key="si"><span v-if="s.type === 'same'" class="diff-same">{{ s.text }}</span><span v-else-if="s.type === 'del'" class="diff-del">{{ s.text }}</span><span v-else class="diff-add">{{ s.text }}</span></template></pre>
                            <pre v-else-if="isMessageExpanded(log.id, e.idx)" class="message-content">{{ e.msg.content }}</pre>
                            <pre v-else class="message-content collapsed">{{ e.msg.content }}</pre>
                          </div>
                        </template>
                      </div>
                      <!-- 对话消息 -->
                      <div v-for="e in messageView(log.id).msgs" :key="e.msg.hash + e.idx" class="message-card" :class="{ rewritten: messageView(log.id).diffMap.has(e.idx) }">
                        <div class="message-header" @click="toggleMessage(log.id, e.idx)">
                          <span class="message-role" :class="roleClass(e.msg.role)">{{ e.msg.role }}</span>
                          <span v-if="messageView(log.id).diffMap.has(e.idx)" class="message-rewritten-badge">{{ t('log.rewritten') }}</span>
                          <span v-if="e.msg.hitCount > 1" class="message-hits" :title="t('log.messageHitsTitle')">{{ t('log.messageHits', { n: e.msg.hitCount }) }}</span>
                          <span class="message-size">{{ formatSize(e.msg.content.length) }}</span>
                          <span class="message-toggle">{{ isMessageExpanded(log.id, e.idx) ? '▾' : '▸' }}</span>
                        </div>
                        <!-- 被改写的消息：展开时直接在卡片内渲染 Git diff 式词级高亮 -->
                        <pre v-if="isMessageExpanded(log.id, e.idx) && messageView(log.id).diffMap.has(e.idx)" class="message-content diff"><template v-for="(s, si) in diffSpans(log.id, e.idx, messageView(log.id).diffMap.get(e.idx)!)" :key="si"><span v-if="s.type === 'same'" class="diff-same">{{ s.text }}</span><span v-else-if="s.type === 'del'" class="diff-del">{{ s.text }}</span><span v-else class="diff-add">{{ s.text }}</span></template></pre>
                        <pre v-else-if="isMessageExpanded(log.id, e.idx)" class="message-content">{{ e.msg.content }}</pre>
                        <pre v-else class="message-content collapsed">{{ e.msg.content }}</pre>
                      </div>
                    </div>
                  </div>
                  <!-- 兼容旧日志：纯文本输入 -->
                  <div v-else-if="getContent(log.id).inputContent" class="content-block">
                    <div class="content-label">{{ t('log.prompt') }} <button class="btn-copy" @click.stop="copyContent(formatContent(getContent(log.id).inputContent!))">{{ t('log.copy') }}</button></div>
                    <pre class="content-text">{{ formatContent(getContent(log.id).inputContent) }}</pre>
                  </div>
                  <div v-if="getContent(log.id).outputContent" class="content-block">
                    <div class="content-label">{{ t('log.response') }} <button class="btn-copy" @click.stop="copyContent(formatContent(getContent(log.id).outputContent!))">{{ t('log.copy') }}</button></div>
                    <pre class="content-text">{{ formatContent(getContent(log.id).outputContent) }}</pre>
                  </div>
                  <div v-if="!log.error && !getContent(log.id).inputContent && !getContent(log.id).outputContent" class="content-block">
                    <div class="content-pruned">{{ t('log.contentPruned') }}</div>
                  </div>
                  </template>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!logs.length">
            <td colspan="10" class="no-logs">{{ t('log.noLogs') }}</td>
          </tr>
        </tbody>
      </table>

      <div class="pagination">
        <button class="btn" :disabled="offset === 0" @click="prev">{{ t('log.prevPage') }}</button>
        <span class="page-info">{{ t('log.offsetLabel', { offset }) }}</span>
        <button class="btn" :disabled="!hasMore" @click="next">{{ t('log.nextPage') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.copy-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--primary);
  color: #fff;
  padding: 8px 20px;
  border-radius: 6px;
  font-size: 13px;
  z-index: 100;
  pointer-events: none;
  animation: toast-fade 1.5s ease;
}
@keyframes toast-fade {
  0% { opacity: 0; transform: translateX(-50%) translateY(8px); }
  15% { opacity: 1; transform: translateX(-50%) translateY(0); }
  80% { opacity: 1; }
  100% { opacity: 0; }
}

.filter-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  align-items: center;
}

.filter-input {
  padding: 6px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
  min-width: 180px;
}

.filter-input:focus {
  outline: none;
  border-color: var(--primary);
}

.filter-checkbox {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.filter-checkbox input {
  accent-color: var(--primary);
}

.auto-refresh-toggle {
  margin-left: auto;
}

.filter-time {
  min-width: 0;
  width: 170px;
  padding: 5px 8px;
  font-size: 12px;
}

.time-sep {
  color: var(--text-dim);
  font-size: 13px;
}

.quick-time-bar {
  display: flex;
  gap: 4px;
  margin-bottom: 12px;
}

.quick-time-bar .btn-sm.active {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}

.filter-select {
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
}

.log-row {
  cursor: pointer;
}

.log-row:hover td {
  background: var(--surface2);
}

.expand-row td {
  padding: 0 12px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.expand-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 0;
}

.content-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-summary {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12px;
  font-family: var(--mono);
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}

.detail-label {
  color: var(--text-dim);
  margin-right: 4px;
  font-family: inherit;
}

.content-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.btn-copy {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 2px 8px;
  border-radius: 3px;
  cursor: pointer;
  font-size: 10px;
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
}

.btn-copy:hover {
  color: var(--text);
  background: var(--surface);
}

.content-text {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
  margin: 0;
}

.no-logs {
  text-align: center;
  color: var(--text-dim);
  padding: 40px 0;
}

.content-pruned {
  color: var(--text-dim);
  font-size: 12px;
  font-style: italic;
}

.cache-hint {
  font-size: 10px;
  color: var(--primary);
  opacity: 0.7;
}

th.sortable {
  cursor: pointer;
  user-select: none;
}

th.sortable:hover {
  color: var(--primary);
}

.fallback-badge {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--warn, #f59e0b);
  background: rgba(245, 158, 11, 0.15);
  border-radius: 3px;
  cursor: help;
  vertical-align: middle;
}

.rewrite-badge {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--primary, #3b82f6);
  background: rgba(59, 130, 246, 0.15);
  border-radius: 3px;
  cursor: help;
  vertical-align: middle;
}

.rewrite-rule-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.rewrite-rule-tag {
  display: inline-block;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--primary, #3b82f6);
  background: rgba(59, 130, 246, 0.12);
  border-radius: 4px;
}

/** 工具声明折叠组 */
.tools-group {
  border: 1px dashed var(--border, #d1d5db);
  border-radius: 6px;
  overflow: hidden;
  /** 列表容器滚动时工具组自身不收缩（否则被大量消息卡片压缩到不可见） */
  flex-shrink: 0;
}

.tools-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  cursor: pointer;
  background: var(--bg-soft, rgba(0, 0, 0, 0.03));
  user-select: none;
}

.tools-group .message-card {
  border: none;
  border-top: 1px solid var(--border, #e5e7eb);
  border-radius: 0;
}

/** 被改写的消息卡片标记 */
.message-card.rewritten {
  border-color: rgba(59, 130, 246, 0.5);
}

.message-rewritten-badge {
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--primary, #3b82f6);
  background: rgba(59, 130, 246, 0.12);
  border-radius: 4px;
}

/** 消息卡片内的 Git diff 式词级高亮 */
.message-content .diff-same {
  color: var(--text-dim);
}

.message-content .diff-del {
  background: rgba(239, 68, 68, 0.15);
  color: var(--tag-red);
  text-decoration: line-through;
  border-radius: 2px;
}

.message-content .diff-add {
  background: rgba(34, 197, 94, 0.15);
  color: var(--tag-green);
  border-radius: 2px;
  font-weight: 600;
}

/** 消息数组渲染 */
.message-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /** 整个列表容器可滚动 */
  max-height: 520px;
  overflow-y: auto;
  padding-right: 4px;
}

.message-card {
  border: 1px solid var(--border);
  border-radius: 6px;
  /** 卡片列表容器滚动时卡片自身不收缩 */
  flex-shrink: 0;
  overflow: hidden;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: var(--surface);
  font-size: 11px;
  cursor: pointer;
  user-select: none;
}

.message-role {
  font-weight: 600;
  padding: 0 8px;
  border-radius: 3px;
  font-size: 10px;
  text-transform: uppercase;
}

.role-system { background: var(--tag-purple-bg); color: var(--tag-purple); }
.role-user { background: var(--tag-blue-bg); color: var(--tag-blue); }
.role-assistant { background: var(--tag-green-bg); color: var(--tag-green); }
.role-other { background: var(--surface2); color: var(--text-dim); }

.message-hits {
  color: var(--primary, #3b82f6);
  font-weight: 600;
}

.message-size {
  color: var(--text-dim);
}

.message-toggle {
  margin-left: auto;
  color: var(--text-dim);
}

.message-content {
  margin: 0;
  padding: 8px 10px;
  font-size: 12px;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
  /** 展开态：默认约 5-6 行，内部滚动，右下角可拖拽调高 */
  height: calc(6 * 1.5em + 16px);
  max-height: 60vh;
  min-height: calc(3 * 1.5em + 16px);
  overflow-y: auto;
  resize: vertical;
}

.message-content.collapsed {
  /** 收起态：单行摘要 */
  height: auto;
  max-height: calc(1.5em + 16px);
  min-height: 0;
  overflow: hidden;
  resize: none;
  color: var(--text-dim);
}

/** 高频消息面板 */
.top-messages-panel {
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  overflow: hidden;
}

.top-messages-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.top-messages-sort {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.top-messages-sort .btn-sm.active {
  border-color: var(--primary);
  color: var(--primary);
}

.top-messages-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}

.top-messages-list {
  max-height: 400px;
  overflow-y: auto;
}

.top-message-item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.top-message-item:last-child {
  border-bottom: none;
}

.top-message-rank {
  font-weight: 600;
  font-size: 12px;
  color: var(--text-dim);
  min-width: 28px;
}

.top-message-stats {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.top-message-size {
  color: var(--text-dim);
}

.top-message-preview {
  flex-basis: 100%;
  margin: 4px 0 0;
  font-size: 11px;
  font-family: monospace;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60px;
  overflow: hidden;
}

.btn-sm {
  padding: 3px 10px;
  font-size: 11px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 5px;
  cursor: pointer;
  font-family: inherit;
}

.btn-sm:hover {
  color: var(--text);
  border-color: var(--primary);
}

.chip-add {
  color: var(--tag-green);
  font-weight: 600;
}

@media (max-width: 768px) {
  .filter-bar {
    flex-wrap: wrap;
    gap: 6px;
  }
  .filter-input {
    min-width: 0;
    flex: 1 1 140px;
  }
  .filter-select {
    flex: 1 1 120px;
    min-width: 0;
  }
  .filter-time {
    flex: 1 1 140px;
    width: auto;
  }
  .table {
    display: block;
    overflow-x: auto;
    min-width: 700px;
  }
  .detail-summary {
    gap: 8px;
  }
}
</style>

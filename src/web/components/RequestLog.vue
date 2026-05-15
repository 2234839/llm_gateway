<script setup lang="ts">
import { ref, onMounted, onUnmounted, onActivated, onDeactivated } from "vue"
import { logApi, providerApi, apiKeyApi, keyGroupApi, type LogEntry, type ProviderInfo, type ApiKeyInfo, type KeyGroupInfo } from "../api"
import { t } from "../i18n"
import { formatDuration, formatNumber } from "../format"
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

/** 筛选条件 */
const filterModel = ref("")
const filterStatus = ref("")
const filterProvider = ref("")
const filterKey = ref("")
const filterGroup = ref("")
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

/** 仅在第一页且无筛选条件时自动刷新 */
function scheduleRefresh() {
  if (offset.value > 0 || filterModel.value || filterStatus.value || filterProvider.value || filterKey.value || filterGroup.value || filterStartTime.value || filterEndTime.value) return
  if (refreshTimer) return
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    load()
  }, 2000)
}

onMounted(async () => {
  const [p, k, g] = await Promise.all([providerApi.list(), apiKeyApi.list(), keyGroupApi.list()])
  providers.value = p
  apiKeys.value = k
  keyGroups.value = g
  await load()
  connectSSE()
})

onUnmounted(() => {
  disconnectSSE()
  if (refreshTimer) clearTimeout(refreshTimer)
})

/** KeepAlive deactivate：暂停 SSE 以节省资源 */
onDeactivated(() => {
  disconnectSSE()
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null }
})

/** KeepAlive activate：恢复 SSE */
onActivated(() => {
  connectSSE()
})

async function load() {
  loading.value = true
  const params: { limit: number; offset: number; model?: string; providerId?: string; apiKeyId?: string; groupId?: string; status?: string; startTime?: string; endTime?: string } = { limit: limit + 1, offset: offset.value }
  if (filterModel.value) params.model = filterModel.value
  if (filterProvider.value) params.providerId = filterProvider.value
  if (filterKey.value) params.apiKeyId = filterKey.value
  if (filterGroup.value) params.groupId = filterGroup.value
  if (filterStatus.value) params.status = filterStatus.value
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
const contentCache = new Map<number, { inputContent: string | null; outputContent: string | null }>()
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
      contentCache.set(id, { inputContent: detail.inputContent, outputContent: detail.outputContent })
      /** 淘汰最旧的缓存条目 */
      if (contentCache.size > MAX_CONTENT_CACHE) {
        const firstKey = contentCache.keys().next().value
        if (firstKey !== undefined) contentCache.delete(firstKey)
      }
    } catch { /* 加载失败，静默处理 */ }
    loadingContent.value = new Set([...loadingContent.value].filter(i => i !== id))
  }
}

/** 获取缓存的 content */
function getContent(id: number): { inputContent: string | null; outputContent: string | null } {
  return contentCache.get(id) ?? { inputContent: null, outputContent: null }
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

/** 复制文本到剪贴板 */
async function copyContent(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /** Clipboard API 不可用时回退到 select + copy */
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
}
</script>

<template>
  <div class="request-log">
    <div class="toolbar">
      <h2>{{ t('log.title') }}</h2>
      <button class="btn" @click="load">{{ t('log.refresh') }}</button>
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
              <td>{{ log.providerName }}<span v-if="log.fallbackAttempts" class="fallback-badge" :title="log.fallbackAttempts">FB</span></td>
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
                  <div v-if="getContent(log.id).inputContent" class="content-block">
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
</style>

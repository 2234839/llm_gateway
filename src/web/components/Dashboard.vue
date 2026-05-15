<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated, nextTick } from "vue"
import { Chart, registerables } from "chart.js"
import { healthApi, tokenApi, type HealthInfo, type TokenStats } from "../api"
import { t } from "../i18n"
import { formatDuration, formatNumber, formatTokenCount } from "../format"
import { subscribeSSE } from "../sse-manager"

Chart.register(...registerables)

const info = ref<HealthInfo | null>(null)
const loadError = ref("")
const loading = ref(true)
const concurrencyCanvas = ref<HTMLCanvasElement | null>(null)
const liveLogsRef = ref<HTMLElement | null>(null)
const tokenTrendCanvas = ref<HTMLCanvasElement | null>(null)

interface LiveRequest {
  requestId: string
  model: string
  targetModel: string
  provider: string
  /** 当前实际请求的 provider ID */
  providerId: string
  /** fallback 切换后的新 provider 名称 */
  fallbackProvider: string | null
  input: string
  output: string
  status: "running" | "done" | "error"
  durationMs: number
  statusCode: number
  error: string | null
  startedAt: number
  /** 命中的路由规则 pattern */
  rulePattern: string | null
  /** 发起请求的密钥名称 */
  keyName: string | null
  /** 密钥所属分组名称 */
  groupName: string | null
  /** Token 用量 */
  tokenUsage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } | null
  /** DOM 滚动节流定时器 */
  _scrollTimer: ReturnType<typeof setTimeout> | null
}

/** 展开的完成请求 ID */
const expandedReqId = ref<string | null>(null)

/** 请求面板状态筛选 */
type RequestFilter = "all" | "done" | "error"
const requestFilter = ref<RequestFilter>("all")

const liveRequests = ref<Map<string, LiveRequest>>(new Map())
const completedRequests = ref<LiveRequest[]>([])

/** 按状态筛选后的已完成请求 */
const filteredCompleted = computed(() => {
  if (requestFilter.value === "all") return completedRequests.value
  return completedRequests.value.filter(r => r.status === requestFilter.value)
})

const providerConcurrency = ref<{ id: string; name: string; gateway: number; upstream: number; max: number; models: { model: string; targetModel: string; count: number }[] }[]>([])

let sseUnsubscribe: (() => void) | null = null
let chartInstance: Chart | null = null
let tokenChartInstance: Chart | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null
/** 每秒更新的时钟，用于运行中请求的耗时显示 */
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | null = null
let themeObserver: MutationObserver | null = null

/** 并发历史数据（两层：upstream + gateway） */
const concurrencyHistory = new Map<string, { name: string; upstreamPoints: number[]; gatewayPoints: number[] }>()
let historyLabels: string[] = []
const maxHistoryPoints = 300

/** Token 趋势图刷新防抖 */
let tokenTrendTimer: ReturnType<typeof setTimeout> | null = null
function scheduleTokenTrendRefresh() {
  if (tokenTrendTimer) return
  tokenTrendTimer = setTimeout(() => {
    tokenTrendTimer = null
    loadTokenTrend()
  }, 3000)
}

async function loadGroupTokenStats() {
  try {
    const [groups, keys] = await Promise.all([tokenApi.byGroup(), tokenApi.byKey()])
    groupTokenStats.value = groups
    keyTokenStats.value = keys
  } catch { /* 静默失败，保留上次数据 */ }
}

/** Token 趋势图时间范围（小时） */
const tokenTrendHours = ref(24)
const tokenTrendOptions = [
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "72h", value: 72 },
  { label: "7d", value: 168 },
]

/** 输出速率历史（tokens/s），与并发共享时间轴 */
const outputRateHistory: number[] = []
/** 输出速率滑动窗口：每个并发采样周期内的 (outputTokens, durationMs) */
let windowOutputTokens = 0
let windowDurationMs = 0
/** EMA 平滑后的当前输出速率 */
let smoothedRate = 0
/** EMA 更新系数：新数据权重 */
const EMA_ALPHA = 0.3
/** 无数据时的衰减系数 */
const EMA_DECAY = 0.85

/** 分组 Token 用量 */
const groupTokenStats = ref<{ groupId: string; groupName: string; total: TokenStats; today: TokenStats }[]>([])
const keyTokenStats = ref<{ keyId: string; keyName: string; groupId: string; groupName: string; total: TokenStats; today: TokenStats }[]>([])

onMounted(async () => {
  try {
    info.value = await healthApi.get()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : "Failed to load dashboard"
    loading.value = false
    return
  }
  loading.value = false
  await nextTick()
  initConcurrencyChart()
  loadTokenTrend()
  loadGroupTokenStats()
  connectSSE()
  cleanupTimer = setInterval(cleanupCompleted, 30000)
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)

  themeObserver = new MutationObserver(() => {
    chartInstance?.destroy()
    chartInstance = null
    tokenChartInstance?.destroy()
    tokenChartInstance = null
    initConcurrencyChart()
    renderConcurrencyChart()
    loadTokenTrend()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
})

onUnmounted(() => {
  disconnectSSE()
  if (tokenTrendTimer) clearTimeout(tokenTrendTimer)
  chartInstance?.destroy()
  tokenChartInstance?.destroy()
  themeObserver?.disconnect()
  if (cleanupTimer) clearInterval(cleanupTimer)
  if (clockTimer) clearInterval(clockTimer)
})

/** KeepAlive deactivate：暂停 SSE、定时器以节省资源 */
onDeactivated(() => {
  disconnectSSE()
  if (tokenTrendTimer) { clearTimeout(tokenTrendTimer); tokenTrendTimer = null }
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null }
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
})

/** KeepAlive activate：恢复 SSE 和定时器 */
onActivated(() => {
  if (!info.value) return
  connectSSE()
  cleanupTimer = setInterval(cleanupCompleted, 30000)
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
  loadTokenTrend()
})

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}${t("dashboard.hourUnit")} ${m}${t("dashboard.minuteUnit")}`
}

async function refresh() {
  loading.value = true
  loadError.value = ""
  try {
    info.value = await healthApi.get()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : "Failed to refresh"
    loading.value = false
    return
  }
  loading.value = false
  await nextTick()
  loadTokenTrend()
  loadGroupTokenStats()
}

/** ========== 并发 + 输出速率双 Y 轴图表 ========== */

function initConcurrencyChart() {
  if (!concurrencyCanvas.value) return
  const ctx = concurrencyCanvas.value.getContext("2d")
  if (!ctx) return
  const style = getComputedStyle(document.documentElement)
  const textDim = style.getPropertyValue("--text-dim").trim() || "#888"
  const border = style.getPropertyValue("--border").trim() || "#2a2a2a"
  chartInstance = new Chart(ctx, {
    type: "bar",
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: {
        legend: { display: true, labels: { color: textDim, font: { size: 11 }, filter: (item: { text: string }) => !item.text.includes(t("dashboard.queuedConcurrency")) }, onClick: () => {} },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { stacked: true, ticks: { color: textDim, maxTicksLimit: 10, font: { size: 10 } }, grid: { color: border } },
        y: {
          stacked: true,
          position: "left",
          beginAtZero: true,
          title: { display: true, text: t("dashboard.concurrency"), color: textDim, font: { size: 11 } },
          ticks: { color: textDim, stepSize: 1 },
          grid: { color: border },
        },
        y1: {
          position: "right",
          beginAtZero: true,
          title: { display: true, text: t('dashboard.tokensPerSec'), color: textDim, font: { size: 11 } },
          ticks: { color: textDim },
          grid: { drawOnChartArea: false },
        },
      },
    },
  })
}

/** 从后端历史快照恢复图表数据（重连时先清空旧数据避免重复） */
function restoreHistory(snapshots: { time: string; providers: { id: string; name: string; gateway: number; upstream: number }[] }[]) {
  historyLabels.length = 0
  outputRateHistory.length = 0
  concurrencyHistory.clear()
  for (const snap of snapshots) {
    historyLabels.push(snap.time)
    for (const p of snap.providers) {
      let entry = concurrencyHistory.get(p.id)
      if (!entry) {
        entry = { name: p.name, upstreamPoints: [], gatewayPoints: [] }
        concurrencyHistory.set(p.id, entry)
      }
      entry.name = p.name
      entry.upstreamPoints.push(p.upstream)
      entry.gatewayPoints.push(p.gateway)
    }
    outputRateHistory.push(0)
  }
  while (historyLabels.length > maxHistoryPoints) historyLabels.shift()
  for (const entry of concurrencyHistory.values()) {
    while (entry.upstreamPoints.length > maxHistoryPoints) entry.upstreamPoints.shift()
    while (entry.gatewayPoints.length > maxHistoryPoints) entry.gatewayPoints.shift()
  }
  while (outputRateHistory.length > maxHistoryPoints) outputRateHistory.shift()
  renderConcurrencyChart()
}

/** 追加单个实时并发数据点并刷新图表 */
function appendChartPoint() {
  if (!chartInstance) return
  const now = new Date()
  const label = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
  historyLabels.push(label)
  if (historyLabels.length > maxHistoryPoints) historyLabels.shift()

  /** 清理已移除 provider 的历史数据 */
  const activeIds = new Set(providerConcurrency.value.map(p => p.id))
  for (const [id] of concurrencyHistory) {
    if (!activeIds.has(id)) concurrencyHistory.delete(id)
  }

  for (const p of providerConcurrency.value) {
    let entry = concurrencyHistory.get(p.id)
    if (!entry) {
      entry = { name: p.name, upstreamPoints: [], gatewayPoints: [] }
      concurrencyHistory.set(p.id, entry)
    }
    entry.name = p.name
    entry.upstreamPoints.push(p.upstream)
    entry.gatewayPoints.push(p.gateway)
    if (entry.upstreamPoints.length > maxHistoryPoints) entry.upstreamPoints.shift()
    if (entry.gatewayPoints.length > maxHistoryPoints) entry.gatewayPoints.shift()
  }

  /** EMA 平滑计算输出速率 */
  if (windowDurationMs > 0) {
    const instantRate = windowOutputTokens / (windowDurationMs / 1000)
    smoothedRate = smoothedRate === 0 ? instantRate : EMA_ALPHA * instantRate + (1 - EMA_ALPHA) * smoothedRate
  } else {
    /** 无新数据时衰减，不直接归零 */
    smoothedRate *= EMA_DECAY
    if (smoothedRate < 0.5) smoothedRate = 0
  }
  outputRateHistory.push(Math.round(smoothedRate))
  if (outputRateHistory.length > maxHistoryPoints) outputRateHistory.shift()
  windowOutputTokens = 0
  windowDurationMs = 0

  renderConcurrencyChart()
}

function renderConcurrencyChart() {
  if (!chartInstance) return
  const colors = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7"]
  const style = getComputedStyle(document.documentElement)
  const textDim = style.getPropertyValue("--text-dim").trim() || "#888"
  const border = style.getPropertyValue("--border").trim() || "#2a2a2a"

  const entries = [...concurrencyHistory.entries()]

  /** 过滤掉全部为 0 的 provider，避免空柱子占据宽度 */
  const activeEntries = entries.filter(([_, e]) => e.gatewayPoints.some(v => v > 0))

  /** 构建 datasets：每个 provider 两层 bar + 总并发折线 + 输出速率折线 */
  const barDatasets: Record<string, unknown>[] = []

  for (const [_, entry] of activeEntries) {
    const i = barDatasets.length
    const color = colors[i % colors.length]
    /** 底层：LLM 并发（实色） */
    barDatasets.push({
      label: entry.name,
      data: [...entry.upstreamPoints],
      backgroundColor: color,
      borderColor: color,
      borderWidth: 0,
      yAxisID: "y",
      stack: entry.name,
      order: 2,
    })
    /** 上层：排队中（半透明，gateway - upstream） */
    barDatasets.push({
      label: `${entry.name} (${t("dashboard.queuedConcurrency")})`,
      data: entry.gatewayPoints.map((g, idx) => Math.max(0, g - (entry.upstreamPoints[idx] ?? 0))),
      backgroundColor: color + "40",
      borderColor: color + "80",
      borderWidth: 1,
      yAxisID: "y",
      stack: entry.name,
      order: 2,
    })
  }

  /** 总并发折线 */
  const totalLength = entries.length > 0 ? Math.max(...entries.map(([_, e]) => e.gatewayPoints.length)) : 0
  const totalPoints: number[] = []
  for (let i = 0; i < totalLength; i++) {
    let sum = 0
    for (const [_, e] of entries) sum += e.gatewayPoints[i] ?? 0
    totalPoints.push(sum)
  }
  barDatasets.push({
    label: t("dashboard.totalConcurrency"),
    data: totalPoints,
    borderColor: "#e2e8f0",
    backgroundColor: "transparent",
    type: "line",
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
    borderDash: [6, 3],
    yAxisID: "y",
    order: 0,
  } as never)

  /** 输出速率折线 */
  barDatasets.push({
    label: t("dashboard.outputRateLabel"),
    data: [...outputRateHistory],
    borderColor: "#f472b6",
    backgroundColor: "transparent",
    type: "line",
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
    borderDash: [4, 2],
    yAxisID: "y1",
    order: 0,
  } as never)

  chartInstance.data.labels = historyLabels
  chartInstance.data.datasets = barDatasets as never
  chartInstance.options.plugins!.legend!.labels!.color = textDim
  chartInstance.options.scales!.x!.ticks!.color = textDim
  chartInstance.options.scales!.x!.grid!.color = border
  chartInstance.options.scales!.y!.ticks!.color = textDim
  chartInstance.options.scales!.y!.grid!.color = border
  chartInstance.options.scales!.y1!.ticks!.color = textDim
  chartInstance.update("none")
}

/** ========== Token 趋势图 ========== */

async function loadTokenTrend() {
  try {
    const data = await tokenApi.hourly(tokenTrendHours.value)
    renderTokenChart(data)
  } catch { /* 静默失败，保留上一次的图表 */ }
}

function setTokenTrendRange(hours: number) {
  tokenTrendHours.value = hours
  loadTokenTrend()
}

function renderTokenChart(data: ({ hour: string } & TokenStats)[]) {
  if (!tokenTrendCanvas.value) return
  tokenChartInstance?.destroy()

  const ctx = tokenTrendCanvas.value.getContext("2d")
  if (!ctx) return
  const style = getComputedStyle(document.documentElement)
  const textDim = style.getPropertyValue("--text-dim").trim() || "#888"
  const border = style.getPropertyValue("--border").trim() || "#2a2a2a"

  const labels = data.map(d => {
    const parts = d.hour.split(" ")
    return parts[1] || d.hour
  })

  tokenChartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: t('dashboard.chartInput'), data: data.map(d => d.inputTokens), backgroundColor: "rgba(245, 158, 11, 0.8)" },
        { label: t('dashboard.chartOutput'), data: data.map(d => d.outputTokens), backgroundColor: "rgba(239, 68, 68, 0.8)" },
        { label: t('dashboard.chartCacheRead'), data: data.map(d => d.cacheReadTokens), backgroundColor: "rgba(34, 197, 94, 0.8)" },
        { label: t('dashboard.chartCacheWrite'), data: data.map(d => d.cacheCreationTokens), backgroundColor: "rgba(59, 130, 246, 0.8)" },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: {
        legend: { display: true, labels: { color: textDim, font: { size: 11 } } },
        tooltip: { mode: "index", intersect: false },
      },
      scales: {
        x: { stacked: true, ticks: { color: textDim, font: { size: 10 } }, grid: { color: border } },
        y: { stacked: true, ticks: { color: textDim, callback: (v) => formatNumber(v as number) }, grid: { color: border } },
      },
    },
  })
}

/** ========== SSE 连接 ========== */

/** 心跳超时：10 秒无消息则重连 */
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
const HEARTBEAT_TIMEOUT = 10_000

function resetHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer)
  heartbeatTimer = setTimeout(() => {
    /** 心跳超时，断开并重连 */
    disconnectSSE()
    connectSSE()
  }, HEARTBEAT_TIMEOUT)
}

function disconnectSSE() {
  if (sseUnsubscribe) { sseUnsubscribe(); sseUnsubscribe = null }
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null }
}

function connectSSE() {
  disconnectSSE()
  /** 重连时重置速率窗口，避免用旧累积值计算尖峰 */
  windowOutputTokens = 0
  windowDurationMs = 0
  smoothedRate = 0
  resetHeartbeat()

  sseUnsubscribe = subscribeSSE((event) => {
    if (event.type === "concurrency_history") {
      restoreHistory(event.snapshots)
    } else if (event.type === "concurrency") {
      providerConcurrency.value = event.providers
      appendChartPoint()
    } else if (event.type === "request_start") {
      liveRequests.value.set(event.requestId, {
        requestId: event.requestId,
        model: event.model,
        targetModel: event.targetModel,
        provider: event.provider,
        providerId: event.providerId ?? "",
        fallbackProvider: null,
        input: event.input,
        output: "",
        status: "running",
        durationMs: 0,
        statusCode: 0,
        error: null,
        startedAt: Date.now(),
        rulePattern: event.rulePattern ?? null,
        keyName: event.keyName ?? null,
        groupName: event.groupName ?? null,
        tokenUsage: null,
        _scrollTimer: null,
      })
    } else if (event.type === "request_stream") {
      const req = liveRequests.value.get(event.requestId)
      if (req) {
        req.output += event.text
        /** 节流 DOM 滚动：每 200ms 最多触发一次 */
        if (!req._scrollTimer) {
          req._scrollTimer = setTimeout(() => {
            req._scrollTimer = null
            nextTick(() => {
              const el = document.querySelector(`.log-item.running[data-rid="${event.requestId}"] .log-output`)
              if (el) el.scrollTop = el.scrollHeight
            })
          }, 200)
        }
      }
    } else if (event.type === "upstream_start") {
      const req = liveRequests.value.get(event.requestId)
      if (req && event.providerId && event.providerId !== req.providerId) {
        req.fallbackProvider = event.providerName ?? event.providerId
        req.providerId = event.providerId
      }
    } else if (event.type === "request_end") {
      const req = liveRequests.value.get(event.requestId)
      if (req) {
        req.status = event.error ? "error" : "done"
        req.durationMs = event.durationMs
        req.statusCode = event.statusCode
        req.error = event.error
        if (event.tokenUsage) {
          req.tokenUsage = { inputTokens: event.tokenUsage.inputTokens ?? 0, outputTokens: event.tokenUsage.outputTokens ?? 0, cacheCreationTokens: event.tokenUsage.cacheCreationTokens ?? 0, cacheReadTokens: event.tokenUsage.cacheReadTokens ?? 0 }
        }
        liveRequests.value.delete(event.requestId)
        completedRequests.value.unshift(req)
        if (completedRequests.value.length > 50) completedRequests.value.length = 50
        /** 新完成的请求插入顶部后，滚动到顶部以显示最新条目 */
        nextTick(() => { if (liveLogsRef.value) liveLogsRef.value.scrollTop = 0 })
      }
      /** 累加到输出速率窗口 */
      if (event.tokenUsage) {
        windowOutputTokens += event.tokenUsage.outputTokens ?? 0
        windowDurationMs += event.durationMs ?? 0
      }
      scheduleTokenTrendRefresh()
    } else if (event.type === "request_stats") {
      if (!info.value) return
      info.value.requests = event.requests
      info.value.requestsByProvider = event.byProvider
      info.value.requestsByModel = event.byModel
      if (event.tokenStats) {
        info.value.tokenStats = event.tokenStats
      }
    }
  })
}

function cleanupCompleted() {
  const cutoff = Date.now()
  completedRequests.value = completedRequests.value.filter(r => cutoff - r.startedAt < 120_000)
  /** 清理超时的 running 请求（超过 10 分钟仍 running 视为孤儿） */
  const staleThreshold = cutoff - 600_000
  for (const [id, req] of liveRequests.value) {
    if (req.status === "running" && req.startedAt < staleThreshold) {
      req.status = "error"
      req.error = "Timed out"
      liveRequests.value.delete(id)
      completedRequests.value.unshift(req)
    }
  }
}

function truncate(s: string, len: number): string {
  if (!s) return ""
  return s.length > len ? s.slice(0, len) + "..." : s
}
</script>

<template>
  <div class="dashboard">
    <div class="toolbar">
      <h2>{{ t('dashboard.title') }} <span v-if="info?.version" class="version-badge">v{{ info.version }}</span></h2>
      <button class="btn" @click="refresh">{{ t('dashboard.refresh') }}</button>
    </div>

    <div v-if="loading" class="loading">{{ t('dashboard.loading') }}</div>

    <div v-else-if="loadError" class="error-banner">{{ loadError }}</div>

    <template v-else-if="info">
      <div class="stats-bar">
        <span class="stat-item"><span class="status-dot ok"></span>{{ t('dashboard.statusOk') }}</span>
        <span class="stat-sep"></span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.uptime') }}</span>{{ formatUptime(info.uptime) }}</span>
        <span class="stat-sep"></span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.providers') }}</span>{{ info.providers.enabled }} / {{ info.providers.total }}</span>
        <span class="stat-sep"></span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.routes') }}</span>{{ info.routeRules }}</span>
        <span class="stat-sep"></span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.totalRequests') }}</span>{{ info.requests.total }}</span>
        <span class="stat-sep"></span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.today') }}</span>{{ info.requests.today }}</span>
        <span class="stat-sep"></span>
        <span class="stat-item" v-if="info.requests.today > 0" :style="{ color: info.requests.todayErrors > 0 ? 'var(--err)' : undefined }"><span class="stat-label">{{ t('dashboard.errorRate') }}</span>{{ info.requests.todayErrors }} ({{ (info.requests.todayErrors / Math.max(info.requests.today, 1) * 100).toFixed(1) }}%)</span>
        <span class="stat-sep" v-if="info.requests.today > 0"></span>
        <span class="stat-item" v-if="info.requests.todayAvgMs > 0"><span class="stat-label">{{ t('dashboard.avgLatency') }}</span>{{ formatDuration(info.requests.todayAvgMs) }}</span>
        <span class="stat-sep" v-if="info.requests.todayAvgMs > 0"></span>
        <span class="stat-item" v-if="info.requests.todayP50Ms > 0"><span class="stat-label">P50</span>{{ formatDuration(info.requests.todayP50Ms) }}</span>
        <span class="stat-sep" v-if="info.requests.todayP50Ms > 0"></span>
        <span class="stat-item" v-if="info.requests.todayP95Ms > 0"><span class="stat-label">P95</span>{{ formatDuration(info.requests.todayP95Ms) }}</span>
        <span class="stat-sep" v-if="info.requests.todayP95Ms > 0"></span>
        <span class="stat-item" v-if="info.requests.todayP99Ms > 0"><span class="stat-label">P99</span>{{ formatDuration(info.requests.todayP99Ms) }}</span>
        <span class="stat-sep" v-if="info.requests.todayP99Ms > 0"></span>
        <span class="stat-item" :title="info.tokenStats?.today ? `${t('dashboard.inputCol')}: ${formatNumber(info.tokenStats.today.inputTokens)}\n${t('dashboard.outputCol')}: ${formatNumber(info.tokenStats.today.outputTokens)}${info.tokenStats.today.cacheReadTokens ? `\n${t('dashboard.cacheReadCol')}: ${formatNumber(info.tokenStats.today.cacheReadTokens)}` : ''}${info.tokenStats.today.cacheCreationTokens ? `\n${t('dashboard.cacheWriteCol')}: ${formatNumber(info.tokenStats.today.cacheCreationTokens)}` : ''}` : undefined"><span class="stat-label">{{ t('dashboard.todayTokens') }}</span>{{ formatTokenCount(info.tokenStats?.today) }}</span>
        <span class="stat-sep"></span>
        <span class="stat-item" :title="info.tokenStats?.total ? `${t('dashboard.inputCol')}: ${formatNumber(info.tokenStats.total.inputTokens)}\n${t('dashboard.outputCol')}: ${formatNumber(info.tokenStats.total.outputTokens)}${info.tokenStats.total.cacheReadTokens ? `\n${t('dashboard.cacheReadCol')}: ${formatNumber(info.tokenStats.total.cacheReadTokens)}` : ''}${info.tokenStats.total.cacheCreationTokens ? `\n${t('dashboard.cacheWriteCol')}: ${formatNumber(info.tokenStats.total.cacheCreationTokens)}` : ''}` : undefined"><span class="stat-label">{{ t('dashboard.totalTokens') }}</span>{{ formatTokenCount(info.tokenStats?.total) }}</span>
      </div>

      <!-- 并发 + 输出速率监控 -->
      <div class="detail-card" style="margin-bottom: 16px">
        <h3>{{ t('dashboard.concurrencyOutputRate') }}</h3>
        <div class="chart-container">
          <canvas ref="concurrencyCanvas"></canvas>
        </div>
        <div v-if="providerConcurrency.length" class="concurrency-grid">
          <div v-for="p in providerConcurrency" :key="p.id" class="concurrency-block">
            <div class="concurrency-item">
              <span class="concurrency-name">{{ p.name }}</span>
              <span :class="['concurrency-value', { active: p.gateway > 0, saturated: p.max && p.gateway >= p.max }]">
                <span class="concurrency-upstream">{{ p.upstream }}</span>
                <span class="concurrency-sep">/</span>
                <span class="concurrency-gateway">{{ p.gateway }}</span>
                <template v-if="p.max">{{ ` / ${p.max}` }}</template>
              </span>
            </div>
            <div v-if="p.models?.length" class="concurrency-models">
              <span v-for="m in p.models" :key="m.model + m.targetModel" class="model-concurrency">
                {{ m.model }} → {{ m.targetModel }} <strong>x{{ m.count }}</strong>
              </span>
            </div>
          </div>
        </div>
        <div v-else class="empty">{{ t('dashboard.noProvider') }}</div>
      </div>

      <!-- Token 用量趋势 -->
      <div class="detail-card" style="margin-bottom: 16px">
        <div class="card-header-row">
          <h3>{{ t('dashboard.tokenTrend') }}</h3>
          <div class="range-tabs">
            <button
              v-for="opt in tokenTrendOptions"
              :key="opt.value"
              :class="['range-tab', { active: tokenTrendHours === opt.value }]"
              @click="setTokenTrendRange(opt.value)"
            >{{ opt.label }}</button>
          </div>
        </div>
        <div class="chart-container">
          <canvas ref="tokenTrendCanvas"></canvas>
        </div>
      </div>

      <!-- 实时请求日志 -->
      <div class="detail-card" style="margin-bottom: 24px">
        <div class="card-header-row">
          <h3>{{ t('dashboard.liveRequests') }}</h3>
          <div class="filter-tabs" v-if="completedRequests.length > 0">
            <button :class="['filter-tab', { active: requestFilter === 'all' }]" @click="requestFilter = 'all'">{{ t('dashboard.filterAll') }}</button>
            <button :class="['filter-tab', { active: requestFilter === 'done' }]" @click="requestFilter = 'done'">{{ t('dashboard.filterDone') }}</button>
            <button :class="['filter-tab', { active: requestFilter === 'error' }]" @click="requestFilter = 'error'">{{ t('dashboard.filterError') }}</button>
            <button class="filter-tab" @click="completedRequests = []">✕</button>
          </div>
        </div>
        <div class="live-logs" ref="liveLogsRef">
          <template v-if="liveRequests.size === 0 && filteredCompleted.length === 0">
            <div class="empty">{{ t('dashboard.waitingRequests') }}</div>
          </template>
          <div v-for="[id, req] in liveRequests" :key="id" class="log-item running" :data-rid="req.requestId">
            <div class="log-header">
              <span class="log-id">#{{ req.requestId }}</span>
              <span class="log-route">{{ req.model }} → {{ req.targetModel }}</span>
              <span v-if="req.rulePattern" class="log-rule">{{ req.rulePattern }}</span>
              <span class="log-provider">{{ req.provider }}</span>
              <span v-if="req.fallbackProvider" class="log-fallback">fallback → {{ req.fallbackProvider }}</span>
              <span v-if="req.keyName" class="log-key">{{ req.keyName }}</span>
              <span v-if="req.groupName" class="log-group">{{ req.groupName }}</span>
              <span class="log-status running">{{ t('dashboard.running') }} · {{ formatDuration(now - req.startedAt) }}</span>
            </div>
            <div v-if="req.input" class="log-input">{{ truncate(req.input, 200) }}</div>
            <div v-if="req.output" class="log-output streaming">{{ req.output }}</div>
          </div>
          <div v-for="req in filteredCompleted" :key="req.requestId" :class="['log-item', req.status, { expanded: expandedReqId === req.requestId }]" @click="expandedReqId = expandedReqId === req.requestId ? null : req.requestId">
            <div class="log-header">
              <span class="log-id">#{{ req.requestId }}</span>
              <span class="log-route">{{ req.model }} → {{ req.targetModel }}</span>
              <span v-if="req.rulePattern" class="log-rule">{{ req.rulePattern }}</span>
              <span class="log-provider">{{ req.provider }}</span>
              <span v-if="req.fallbackProvider" class="log-fallback">fallback → {{ req.fallbackProvider }}</span>
              <span v-if="req.keyName" class="log-key">{{ req.keyName }}</span>
              <span v-if="req.groupName" class="log-group">{{ req.groupName }}</span>
              <span :class="['log-status', req.status]">
                <template v-if="req.status === 'done'">{{ formatDuration(req.durationMs) }}<template v-if="req.tokenUsage"> · {{ formatNumber(req.tokenUsage.inputTokens + req.tokenUsage.outputTokens) }} tokens<template v-if="req.tokenUsage.cacheReadTokens > 0 || req.tokenUsage.cacheCreationTokens > 0"> <span class="cache-hint" title="Cache read: {{ req.tokenUsage.cacheReadTokens }}, Cache write: {{ req.tokenUsage.cacheCreationTokens }}">C</span></template></template></template>
                <template v-else>{{ req.statusCode }}</template>
              </span>
            </div>
            <template v-if="expandedReqId === req.requestId">
              <div v-if="req.tokenUsage" class="log-token-detail">
                <span>in: {{ formatNumber(req.tokenUsage.inputTokens) }}</span>
                <span>out: {{ formatNumber(req.tokenUsage.outputTokens) }}</span>
                <span v-if="req.tokenUsage.cacheCreationTokens">cache write: {{ formatNumber(req.tokenUsage.cacheCreationTokens) }}</span>
                <span v-if="req.tokenUsage.cacheReadTokens">cache read: {{ formatNumber(req.tokenUsage.cacheReadTokens) }}</span>
              </div>
              <div v-if="req.input" class="log-input expanded">{{ req.input }}</div>
              <div v-if="req.output" class="log-output expanded">{{ req.output }}</div>
              <div v-if="req.error" class="log-error expanded">{{ req.error }}</div>
            </template>
            <template v-else>
              <div v-if="req.input" class="log-input">{{ truncate(req.input, 200) }}</div>
              <div v-if="req.output" class="log-output">{{ truncate(req.output, 200) }}</div>
              <div v-if="req.error" class="log-error">{{ truncate(req.error, 100) }}</div>
            </template>
          </div>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-card">
          <h3>{{ t('dashboard.providerStats') }}</h3>
          <table class="table" v-if="info.requestsByProvider.length">
            <thead>
              <tr><th>{{ t('dashboard.providerCol') }}</th><th>{{ t('dashboard.totalCol') }}</th><th>{{ t('dashboard.todayCol') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in info.requestsByProvider" :key="row.providerId">
                <td>{{ row.providerName }}</td>
                <td class="mono">{{ row.total }}</td>
                <td class="mono">{{ row.today }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">{{ t('dashboard.noData') }}</div>
        </div>

        <div class="detail-card">
          <h3>{{ t('dashboard.modelStats') }}</h3>
          <table class="table" v-if="info.requestsByModel.length">
            <thead>
              <tr><th>{{ t('dashboard.requestModel') }}</th><th>{{ t('dashboard.mappedModel') }}</th><th>{{ t('dashboard.totalCol') }}</th><th>{{ t('dashboard.todayCol') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in info.requestsByModel" :key="row.model + row.targetModel">
                <td class="mono">{{ row.model }}</td>
                <td class="mono">{{ row.targetModel }}</td>
                <td class="mono">{{ row.total }}</td>
                <td class="mono">{{ row.today }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">{{ t('dashboard.noData') }}</div>
        </div>

        <div class="detail-card">
          <h3>{{ t('dashboard.providerTokenUsage') }}</h3>
          <table class="table" v-if="info.tokensByProvider?.length">
            <thead>
              <tr><th rowspan="2">{{ t('dashboard.providerCol') }}</th><th colspan="4">{{ t('dashboard.totalCol') }}</th><th colspan="4">{{ t('dashboard.todayCol') }}</th></tr>
              <tr><th>{{ t('dashboard.inputCol') }}</th><th>{{ t('dashboard.outputCol') }}</th><th>{{ t('dashboard.cacheReadCol') }}</th><th>{{ t('dashboard.cacheWriteCol') }}</th><th>{{ t('dashboard.inputCol') }}</th><th>{{ t('dashboard.outputCol') }}</th><th>{{ t('dashboard.cacheReadCol') }}</th><th>{{ t('dashboard.cacheWriteCol') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in info.tokensByProvider" :key="row.providerId">
                <td>{{ row.providerName }}</td>
                <td class="mono">{{ formatNumber(row.total.inputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.total.outputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.total.cacheReadTokens) }}</td>
                <td class="mono">{{ formatNumber(row.total.cacheCreationTokens) }}</td>
                <td class="mono">{{ formatNumber(row.today.inputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.today.outputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.today.cacheReadTokens) }}</td>
                <td class="mono">{{ formatNumber(row.today.cacheCreationTokens) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">{{ t('dashboard.noData') }}</div>
        </div>

        <div class="detail-card">
          <h3>{{ t('dashboard.modelTokenUsage') }}</h3>
          <table class="table" v-if="info.tokensByModel?.length">
            <thead>
              <tr><th rowspan="2">{{ t('dashboard.requestModel') }}</th><th rowspan="2">{{ t('dashboard.mappedModel') }}</th><th colspan="4">{{ t('dashboard.totalCol') }}</th><th colspan="4">{{ t('dashboard.todayCol') }}</th></tr>
              <tr><th>{{ t('dashboard.inputCol') }}</th><th>{{ t('dashboard.outputCol') }}</th><th>{{ t('dashboard.cacheReadCol') }}</th><th>{{ t('dashboard.cacheWriteCol') }}</th><th>{{ t('dashboard.inputCol') }}</th><th>{{ t('dashboard.outputCol') }}</th><th>{{ t('dashboard.cacheReadCol') }}</th><th>{{ t('dashboard.cacheWriteCol') }}</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in info.tokensByModel" :key="row.model + row.targetModel">
                <td class="mono">{{ row.model }}</td>
                <td class="mono">{{ row.targetModel }}</td>
                <td class="mono">{{ formatNumber(row.total.inputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.total.outputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.total.cacheReadTokens) }}</td>
                <td class="mono">{{ formatNumber(row.total.cacheCreationTokens) }}</td>
                <td class="mono">{{ formatNumber(row.today.inputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.today.outputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.today.cacheReadTokens) }}</td>
                <td class="mono">{{ formatNumber(row.today.cacheCreationTokens) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">{{ t('dashboard.noData') }}</div>
        </div>
      </div>

      <!-- 分组 Token 用量 -->
      <div v-if="groupTokenStats.length" class="detail-card" style="margin-bottom: 16px">
        <h3>{{ t('dashboard.groupTokenUsage') }}</h3>
        <table class="table">
          <thead>
            <tr><th rowspan="2">{{ t('dashboard.groupCol') }}</th><th colspan="5">{{ t('dashboard.totalCol') }}</th><th colspan="5">{{ t('dashboard.todayCol') }}</th></tr>
            <tr><th>{{ t('dashboard.inputCol') }}</th><th>{{ t('dashboard.outputCol') }}</th><th>{{ t('dashboard.cacheReadCol') }}</th><th>{{ t('dashboard.cacheWriteCol') }}</th><th>{{ t('dashboard.usage') }}</th><th>{{ t('dashboard.inputCol') }}</th><th>{{ t('dashboard.outputCol') }}</th><th>{{ t('dashboard.cacheReadCol') }}</th><th>{{ t('dashboard.cacheWriteCol') }}</th><th>{{ t('dashboard.usage') }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in groupTokenStats" :key="row.groupId">
              <td>{{ row.groupName }}</td>
              <td class="mono">{{ formatNumber(row.total.inputTokens) }}</td>
              <td class="mono">{{ formatNumber(row.total.outputTokens) }}</td>
              <td class="mono">{{ formatNumber(row.total.cacheReadTokens) }}</td>
              <td class="mono">{{ formatNumber(row.total.cacheCreationTokens) }}</td>
              <td class="mono">{{ formatNumber(row.total.inputTokens + row.total.outputTokens + row.total.cacheCreationTokens + row.total.cacheReadTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.inputTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.outputTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.cacheReadTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.cacheCreationTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.inputTokens + row.today.outputTokens + row.today.cacheCreationTokens + row.today.cacheReadTokens) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 密钥 Token 用量 -->
      <div v-if="keyTokenStats.length" class="detail-card" style="margin-bottom: 16px">
        <h3>{{ t('dashboard.keyTokenUsage') }}</h3>
        <table class="table">
          <thead>
            <tr><th rowspan="2">{{ t('dashboard.keyCol') }}</th><th rowspan="2">{{ t('dashboard.groupCol') }}</th><th colspan="5">{{ t('dashboard.totalCol') }}</th><th colspan="5">{{ t('dashboard.todayCol') }}</th></tr>
            <tr><th>{{ t('dashboard.inputCol') }}</th><th>{{ t('dashboard.outputCol') }}</th><th>{{ t('dashboard.cacheReadCol') }}</th><th>{{ t('dashboard.cacheWriteCol') }}</th><th>{{ t('dashboard.usage') }}</th><th>{{ t('dashboard.inputCol') }}</th><th>{{ t('dashboard.outputCol') }}</th><th>{{ t('dashboard.cacheReadCol') }}</th><th>{{ t('dashboard.cacheWriteCol') }}</th><th>{{ t('dashboard.usage') }}</th></tr>
          </thead>
          <tbody>
            <tr v-for="row in keyTokenStats" :key="row.keyId">
              <td>{{ row.keyName }}</td>
              <td>{{ row.groupName }}</td>
              <td class="mono">{{ formatNumber(row.total.inputTokens) }}</td>
              <td class="mono">{{ formatNumber(row.total.outputTokens) }}</td>
              <td class="mono">{{ formatNumber(row.total.cacheReadTokens) }}</td>
              <td class="mono">{{ formatNumber(row.total.cacheCreationTokens) }}</td>
              <td class="mono">{{ formatNumber(row.total.inputTokens + row.total.outputTokens + row.total.cacheCreationTokens + row.total.cacheReadTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.inputTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.outputTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.cacheReadTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.cacheCreationTokens) }}</td>
              <td class="mono">{{ formatNumber(row.today.inputTokens + row.today.outputTokens + row.today.cacheCreationTokens + row.today.cacheReadTokens) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div class="info-section">
      <h3>{{ t('dashboard.usage') }}</h3>
      <pre class="code-block">{{ t('dashboard.anthropicComment') }}
export ANTHROPIC_BASE_URL=http://localhost:{{ info?.port }}
export ANTHROPIC_API_KEY=your-key

{{ t('dashboard.openaiComment') }}
export OPENAI_BASE_URL=http://localhost:{{ info?.port }}/v1
export OPENAI_API_KEY=your-key</pre>
    </div>
  </div>
</template>

<style scoped>
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 24px;
}

.detail-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
}

.detail-card h3 {
  font-size: 14px;
  color: var(--text-dim);
  margin-bottom: 12px;
}

.card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.card-header-row h3 {
  margin-bottom: 0;
}

.range-tabs,
.filter-tabs {
  display: flex;
  gap: 2px;
  background: var(--bg);
  border-radius: 6px;
  padding: 2px;
}

.range-tab,
.filter-tab {
  padding: 3px 10px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s;
}

.range-tab:hover {
  color: var(--text);
}

.range-tab.active,
.filter-tab.active {
  background: var(--surface2);
  color: var(--text);
}

.detail-card .table {
  font-size: 13px;
}

.empty {
  text-align: center;
  padding: 24px;
  color: var(--text-dim);
  font-size: 13px;
}

.chart-container {
  height: 200px;
  margin-bottom: 12px;
}

.concurrency-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.concurrency-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.concurrency-models {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding-left: 4px;
}

.model-concurrency {
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 6px;
  background: rgba(99, 102, 241, 0.1);
  border-radius: 3px;
  color: var(--text-dim);
}

.concurrency-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.concurrency-name {
  color: var(--text-dim);
}

.concurrency-value {
  font-family: var(--mono);
  font-weight: 600;
  color: var(--text-dim);
}

.concurrency-value.active {
  color: var(--ok);
}

.concurrency-value.saturated {
  color: var(--warn, #f59e0b);
}

.concurrency-upstream {
  color: var(--ok);
}

.concurrency-sep {
  color: var(--text-dim);
  opacity: 0.5;
}

.concurrency-gateway {
  color: var(--primary);
}

.live-logs {
  max-height: 400px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.log-item {
  background: var(--surface2);
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 13px;
  border-left: 3px solid var(--text-dim);
}

.log-item.running {
  border-left-color: var(--primary);
}

.log-item.done {
  border-left-color: var(--ok);
}

.log-item.error {
  border-left-color: var(--err);
}

.log-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.log-id {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.7;
}

.log-route {
  font-family: var(--mono);
  font-weight: 600;
  font-size: 12px;
}

.log-rule {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-hover);
  padding: 1px 6px;
  border-radius: 3px;
  font-family: var(--mono);
}

.log-provider {
  color: var(--text-dim);
  font-size: 12px;
}

.log-key {
  font-size: 11px;
  color: var(--text-dim);
  background: rgba(99, 102, 241, 0.1);
  padding: 1px 6px;
  border-radius: 3px;
}

.log-group {
  font-size: 11px;
  color: var(--text-dim);
  background: rgba(245, 158, 11, 0.1);
  padding: 1px 6px;
  border-radius: 3px;
}

.log-fallback {
  font-size: 11px;
  color: var(--warn, #f59e0b);
  background: rgba(245, 158, 11, 0.15);
  padding: 1px 6px;
  border-radius: 3px;
  font-family: var(--mono);
}

.log-status {
  margin-left: auto;
  font-size: 12px;
  font-family: var(--mono);
  color: var(--text-dim);
}

.log-status.done { color: var(--ok); }
.log-status.error { color: var(--err); }
.log-status.running { color: var(--primary); }

.log-input {
  color: var(--text-dim);
  font-size: 12px;
  margin-bottom: 4px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 60px;
  overflow: hidden;
}

.log-output {
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow: hidden;
  color: var(--text);
}

.log-output.streaming {
  color: var(--primary-hover);
  overflow-y: auto;
}

.log-error {
  color: var(--err);
  font-size: 12px;
  margin-top: 4px;
}

.log-item:not(.running) {
  cursor: pointer;
}

.log-item:not(.running):hover {
  background: var(--surface);
}

.log-token-detail {
  display: flex;
  gap: 12px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--text-dim);
  padding: 4px 0;
  margin-top: 2px;
}

.log-input.expanded,
.log-output.expanded,
.log-error.expanded {
  max-height: none;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.cache-hint {
  display: inline-block;
  padding: 0 4px;
  background: rgba(99, 102, 241, 0.15);
  color: var(--primary-hover);
  border-radius: 3px;
  font-size: 10px;
  cursor: help;
}

.version-badge {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-dim);
  background: var(--surface2);
  padding: 2px 8px;
  border-radius: 4px;
  margin-left: 8px;
  vertical-align: middle;
}
</style>

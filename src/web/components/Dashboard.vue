<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick } from "vue"
import { Chart, registerables } from "chart.js"
import { healthApi, tokenApi, type HealthInfo, type TokenStats } from "../api"
import { t } from "../i18n"

Chart.register(...registerables)

const info = ref<HealthInfo | null>(null)
const loading = ref(true)
const concurrencyCanvas = ref<HTMLCanvasElement | null>(null)
const tokenTrendCanvas = ref<HTMLCanvasElement | null>(null)

interface LiveRequest {
  requestId: string
  model: string
  targetModel: string
  provider: string
  input: string
  output: string
  status: "running" | "done" | "error"
  durationMs: number
  statusCode: number
  error: string | null
  startedAt: number
}

const liveRequests = ref<Map<string, LiveRequest>>(new Map())
const completedRequests = ref<LiveRequest[]>([])
const providerConcurrency = ref<{ id: string; name: string; current: number; max: number; models: { model: string; targetModel: string; count: number }[] }[]>([])

let eventSource: EventSource | null = null
let chartInstance: Chart | null = null
let tokenChartInstance: Chart | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null
let themeObserver: MutationObserver | null = null

/** 并发历史数据 */
const concurrencyHistory = new Map<string, { name: string; points: number[] }>()
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

/** 输出速率历史（tokens/s），与并发共享时间轴 */
const outputRateHistory: number[] = []
/** 输出速率滑动窗口：每个并发采样周期内的 (outputTokens, durationMs) */
let windowOutputTokens = 0
let windowDurationMs = 0

onMounted(async () => {
  info.value = await healthApi.get()
  loading.value = false
  await nextTick()
  initConcurrencyChart()
  loadTokenTrend()
  connectSSE()
  cleanupTimer = setInterval(cleanupCompleted, 30000)

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
  eventSource?.close()
  chartInstance?.destroy()
  tokenChartInstance?.destroy()
  themeObserver?.disconnect()
  if (cleanupTimer) clearInterval(cleanupTimer)
})

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}${t("dashboard.hourUnit")} ${m}${t("dashboard.minuteUnit")}`
}

function formatTokenCount(stats: TokenStats | undefined): string {
  if (!stats) return "0"
  const total = stats.inputTokens + stats.outputTokens + (stats.cacheCreationTokens ?? 0) + (stats.cacheReadTokens ?? 0)
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M`
  if (total >= 1_000) return `${(total / 1_000).toFixed(1)}K`
  return String(total)
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

async function refresh() {
  loading.value = true
  info.value = await healthApi.get()
  loading.value = false
  await nextTick()
  loadTokenTrend()
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
    type: "line",
    data: { labels: [], datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: { legend: { display: true, labels: { color: textDim, font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: textDim, maxTicksLimit: 10, font: { size: 10 } }, grid: { color: border } },
        y: {
          position: "left",
          beginAtZero: true,
          title: { display: true, text: t("dashboard.concurrency"), color: textDim, font: { size: 11 } },
          ticks: { color: textDim, stepSize: 1 },
          grid: { color: border },
        },
        y1: {
          position: "right",
          beginAtZero: true,
          title: { display: true, text: "tokens/s", color: textDim, font: { size: 11 } },
          ticks: { color: textDim },
          grid: { drawOnChartArea: false },
        },
      },
    },
  })
}

/** 从后端历史快照恢复图表数据 */
function restoreHistory(snapshots: { time: string; providers: { id: string; name: string; current: number }[] }[]) {
  for (const snap of snapshots) {
    historyLabels.push(snap.time)
    for (const p of snap.providers) {
      let entry = concurrencyHistory.get(p.id)
      if (!entry) {
        entry = { name: p.name, points: [] }
        concurrencyHistory.set(p.id, entry)
      }
      entry.points.push(p.current)
    }
    outputRateHistory.push(0)
  }
  while (historyLabels.length > maxHistoryPoints) historyLabels.shift()
  for (const entry of concurrencyHistory.values()) {
    while (entry.points.length > maxHistoryPoints) entry.points.shift()
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

  for (const p of providerConcurrency.value) {
    let entry = concurrencyHistory.get(p.id)
    if (!entry) {
      entry = { name: p.name, points: [] }
      concurrencyHistory.set(p.id, entry)
    }
    entry.points.push(p.current)
    if (entry.points.length > maxHistoryPoints) entry.points.shift()
  }

  /** 计算该时间窗口的输出速率 */
  const rate = windowDurationMs > 0 ? Math.round(windowOutputTokens / (windowDurationMs / 1000)) : 0
  outputRateHistory.push(rate)
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

  /** 总并发：各 provider 并发数按时间点求和 */
  const totalLength = entries.length > 0 ? Math.max(...entries.map(([_, e]) => e.points.length)) : 0
  const totalPoints: number[] = []
  for (let i = 0; i < totalLength; i++) {
    let sum = 0
    for (const [_, e] of entries) sum += e.points[i] ?? 0
    totalPoints.push(sum)
  }

  const concurrencyDatasets = entries.map(([_, entry], i) => ({
    label: entry.name,
    data: [...entry.points],
    borderColor: colors[i % colors.length],
    backgroundColor: "transparent",
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
    yAxisID: "y",
  }))

  const totalDataset = {
    label: t("dashboard.totalConcurrency"),
    data: totalPoints,
    borderColor: "#e2e8f0",
    backgroundColor: "transparent",
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
    borderDash: [6, 3],
    yAxisID: "y",
  }

  const rateDataset = {
    label: t("dashboard.outputRateLabel"),
    data: [...outputRateHistory],
    borderColor: "#f472b6",
    backgroundColor: "transparent",
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
    borderDash: [4, 2],
    yAxisID: "y1",
  }

  chartInstance.data.labels = historyLabels
  chartInstance.data.datasets = [...concurrencyDatasets, totalDataset, rateDataset]
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
  const data = await tokenApi.hourly(24)
  renderTokenChart(data)
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
        { label: "Input", data: data.map(d => d.inputTokens), backgroundColor: "rgba(245, 158, 11, 0.8)" },
        { label: "Output", data: data.map(d => d.outputTokens), backgroundColor: "rgba(239, 68, 68, 0.8)" },
        { label: "Cache Read", data: data.map(d => d.cacheReadTokens), backgroundColor: "rgba(34, 197, 94, 0.8)" },
        { label: "Cache Write", data: data.map(d => d.cacheCreationTokens), backgroundColor: "rgba(59, 130, 246, 0.8)" },
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

function connectSSE() {
  eventSource = new EventSource("/admin/events")
  eventSource.onmessage = (e) => {
    const event = JSON.parse(e.data)
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
        input: event.input,
        output: "",
        status: "running",
        durationMs: 0,
        statusCode: 0,
        error: null,
        startedAt: Date.now(),
      })
    } else if (event.type === "request_stream") {
      const req = liveRequests.value.get(event.requestId)
      if (req) {
        req.output += event.text
        nextTick(() => {
          const el = document.querySelector(`.log-item.running[data-rid="${event.requestId}"] .log-output`)
          if (el) el.scrollTop = el.scrollHeight
        })
      }
    } else if (event.type === "request_end") {
      const req = liveRequests.value.get(event.requestId)
      if (req) {
        req.status = event.error ? "error" : "done"
        req.durationMs = event.durationMs
        req.statusCode = event.statusCode
        req.error = event.error
        liveRequests.value.delete(event.requestId)
        completedRequests.value.unshift(req)
        if (completedRequests.value.length > 50) completedRequests.value.length = 50
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
  }
}

function cleanupCompleted() {
  const now = Date.now()
  completedRequests.value = completedRequests.value.filter(r => now - r.startedAt < 120_000)
}

function truncate(s: string, len: number): string {
  if (!s) return ""
  return s.length > len ? s.slice(0, len) + "..." : s
}
</script>

<template>
  <div class="dashboard">
    <div class="toolbar">
      <h2>{{ t('dashboard.title') }}</h2>
      <button class="btn" @click="refresh">{{ t('dashboard.refresh') }}</button>
    </div>

    <div v-if="loading" class="loading">{{ t('dashboard.loading') }}</div>

    <template v-else-if="info">
      <div class="stats-bar">
        <span class="stat-item"><span class="status-dot ok"></span>ok</span>
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
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.todayTokens') }}</span>{{ formatTokenCount(info.tokenStats?.today) }}</span>
        <span class="stat-sep"></span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.totalTokens') }}</span>{{ formatTokenCount(info.tokenStats?.total) }}</span>
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
              <span :class="['concurrency-value', { active: p.current > 0 }]">
                {{ p.current }}{{ p.max ? ` / ${p.max}` : "" }}
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
        <h3>{{ t('dashboard.tokenTrend') }}</h3>
        <div class="chart-container">
          <canvas ref="tokenTrendCanvas"></canvas>
        </div>
      </div>

      <!-- 实时请求日志 -->
      <div class="detail-card" style="margin-bottom: 24px">
        <h3>{{ t('dashboard.liveRequests') }}</h3>
        <div class="live-logs">
          <template v-if="liveRequests.size === 0 && completedRequests.length === 0">
            <div class="empty">{{ t('dashboard.waitingRequests') }}</div>
          </template>
          <div v-for="[id, req] in liveRequests" :key="id" class="log-item running" :data-rid="req.requestId">
            <div class="log-header">
              <span class="log-id">#{{ req.requestId }}</span>
              <span class="log-route">{{ req.model }} → {{ req.targetModel }}</span>
              <span class="log-provider">{{ req.provider }}</span>
              <span class="log-status running">{{ t('dashboard.running') }}</span>
            </div>
            <div v-if="req.input" class="log-input">{{ truncate(req.input, 200) }}</div>
            <div v-if="req.output" class="log-output streaming">{{ req.output }}</div>
          </div>
          <div v-for="req in completedRequests" :key="req.requestId" :class="['log-item', req.status]">
            <div class="log-header">
              <span class="log-id">#{{ req.requestId }}</span>
              <span class="log-route">{{ req.model }} → {{ req.targetModel }}</span>
              <span class="log-provider">{{ req.provider }}</span>
              <span :class="['log-status', req.status]">
                <template v-if="req.status === 'done'">{{ req.durationMs }}ms</template>
                <template v-else>{{ req.statusCode }}</template>
              </span>
            </div>
            <div v-if="req.input" class="log-input">{{ truncate(req.input, 200) }}</div>
            <div v-if="req.output" class="log-output">{{ truncate(req.output, 500) }}</div>
            <div v-if="req.error" class="log-error">{{ truncate(req.error, 200) }}</div>
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
              <tr><th>{{ t('dashboard.providerCol') }}</th><th>Input</th><th>Output</th><th>Cache R</th><th>Cache W</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in info.tokensByProvider" :key="row.providerId">
                <td>{{ row.providerName }}</td>
                <td class="mono">{{ formatNumber(row.inputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.outputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.cacheReadTokens) }}</td>
                <td class="mono">{{ formatNumber(row.cacheCreationTokens) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">{{ t('dashboard.noData') }}</div>
        </div>

        <div class="detail-card">
          <h3>{{ t('dashboard.modelTokenUsage') }}</h3>
          <table class="table" v-if="info.tokensByModel?.length">
            <thead>
              <tr><th>{{ t('dashboard.requestModel') }}</th><th>{{ t('dashboard.mappedModel') }}</th><th>Input</th><th>Output</th><th>Cache R</th><th>Cache W</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in info.tokensByModel" :key="row.model + row.targetModel">
                <td class="mono">{{ row.model }}</td>
                <td class="mono">{{ row.targetModel }}</td>
                <td class="mono">{{ formatNumber(row.inputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.outputTokens) }}</td>
                <td class="mono">{{ formatNumber(row.cacheReadTokens) }}</td>
                <td class="mono">{{ formatNumber(row.cacheCreationTokens) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">{{ t('dashboard.noData') }}</div>
        </div>
      </div>
    </template>

    <div class="info-section">
      <h3>{{ t('dashboard.usage') }}</h3>
      <pre class="code-block">{{ t('dashboard.anthropicComment') }}
export ANTHROPIC_BASE_URL=http://localhost:{{ info?.port }}/anthropic
export ANTHROPIC_API_KEY=your-key

{{ t('dashboard.openaiComment') }}
export OPENAI_BASE_URL=http://localhost:{{ info?.port }}/openai/v1
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

.log-provider {
  color: var(--text-dim);
  font-size: 12px;
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
</style>

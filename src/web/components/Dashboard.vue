<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onActivated, onDeactivated, nextTick } from "vue"
import { Chart, registerables } from "chart.js"
import { healthApi, tokenApi, type HealthInfo, type TokenStats } from "../api"
import { t } from "../i18n"
import { formatDuration, formatNumber, formatTokenCount } from "../format"
import { getStableColor } from "../utils/color"
import { subscribeSSE } from "../sse-manager"
import SkuUsageWidget from "./SkuUsageWidget.vue"

Chart.register(...registerables)

const info = ref<HealthInfo | null>(null)
const loadError = ref("")
const loading = ref(true)
const concurrencyCanvas = ref<HTMLCanvasElement | null>(null)
const ganttCanvas = ref<HTMLCanvasElement | null>(null)
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

const providerConcurrency = ref<{ id: string; name: string; color?: string; gateway: number; upstream: number; max: number; models: { model: string; targetModel: string; count: number }[] }[]>([])

let sseUnsubscribe: (() => void) | null = null
let chartInstance: Chart | null = null
let ganttInstance: Chart | null = null
let tokenChartInstance: Chart | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null
/** 每秒更新的时钟，用于运行中请求的耗时显示 */
const now = ref(Date.now())
let clockTimer: ReturnType<typeof setInterval> | null = null
let themeObserver: MutationObserver | null = null

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

/** 输出速率采样：{ ts: 采样时刻时间戳, rate: chars/s }，服务端每秒推一次 */
const outputRateHistory: { ts: number; rate: number }[] = []
/** 速率历史最大点数（与甘特图窗口匹配：5 分钟 = 300 个秒级采样） */
const maxRatePoints = 300

/** 甘特图请求追踪：所有请求（running + completed），用于渲染时间线 */
interface GanttRequest {
  requestId: string
  /** 客户端请求的模型名 */
  model: string
  /** 路由命中的目标模型（实际发往上游的模型名） */
  targetModel: string
  provider: string
  providerId: string
  startedAt: number
  endedAt: number | null  /** null = running */
  status: "running" | "done" | "error"
  statusCode: number
  error: string | null
  durationMs: number
  tokenUsage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number } | null
}
/**
 * 甘特图请求追踪：requestId -> 请求信息。
 * 必须用 Map：SSE 重连时服务端会重放活跃请求的 request_start，数组 push 会产生重复条目，
 * 导致同一请求在泳道分配时因时间自冲突被分到多条泳道。
 */
const ganttRequests = ref<Map<string, GanttRequest>>(new Map())
/** 甘特图显示窗口（毫秒）：横轴为纯真实时间，恒定 [now-30min, now] 平滑左移 */
const GANTT_WINDOW_MS = 30 * 60_000
/** 甘特图最大追踪请求数（与后端 GANTT_MAX_ENTRIES 对齐） */
const GANTT_MAX_REQUESTS = 200

/** 持久化泳道的单条区间记录 */
interface GanttLaneEntry {
  /** 请求 ID，用于同步存活状态 */
  id: string
  start: number
  end: number
}
/** 持久化泳道：行号一经分配不再变化，旧请求滑出后其余柱子绝不换行 */
const ganttLanes: GanttLaneEntry[][] = []
/** 请求 ID -> 泳道行号 */
const ganttLaneOf = new Map<string, number>()
/** 当前鼠标悬停的请求 ID：由 onHover 回调维护，hoverHighlightPlugin 据此绘制高亮 */
let ganttHoverId: string | null = null

/** 分组 Token 用量 */
const groupTokenStats = ref<{ groupId: string; groupName: string; total: TokenStats; today: TokenStats }[]>([])
const keyTokenStats = ref<{ keyId: string; keyName: string; groupId: string; groupName: string; total: TokenStats; today: TokenStats }[]>([])

/** 卡片折叠状态 */
const LS_KEY_COLLAPSED = "dashboard_collapsed_v2"
const collapsedCards = ref<Set<string>>(new Set())

function loadCollapsedState() {
  try {
    const saved = localStorage.getItem(LS_KEY_COLLAPSED)
    if (saved) collapsedCards.value = new Set(JSON.parse(saved) as string[])
  } catch { /* ignore */ }
}

function toggleCollapse(cardId: string) {
  const next = new Set(collapsedCards.value)
  if (next.has(cardId)) next.delete(cardId)
  else next.add(cardId)
  collapsedCards.value = next
  localStorage.setItem(LS_KEY_COLLAPSED, JSON.stringify([...next]))
}

function isCollapsed(cardId: string): boolean {
  return collapsedCards.value.has(cardId)
}

/** 卡片拖拽排序 */
const LS_KEY_MAIN_ORDER = "dashboard_main_order_v2"
const LS_KEY_GRID_ORDER = "dashboard_grid_order_v2"

const DEFAULT_MAIN_ORDER = ["concurrency", "sku-usage", "token-trend", "live-requests", "group-token", "key-token"]
const DEFAULT_GRID_ORDER = ["provider-stats", "model-stats", "provider-token", "model-token"]

const mainCardOrder = ref<string[]>([...DEFAULT_MAIN_ORDER])
const gridCardOrder = ref<string[]>([...DEFAULT_GRID_ORDER])

function loadCardOrder() {
  try {
    const main = localStorage.getItem(LS_KEY_MAIN_ORDER)
    if (main) {
      const parsed = JSON.parse(main) as string[]
      if (parsed.length === DEFAULT_MAIN_ORDER.length && parsed.every(id => DEFAULT_MAIN_ORDER.includes(id))) {
        mainCardOrder.value = parsed
      }
    }
    const grid = localStorage.getItem(LS_KEY_GRID_ORDER)
    if (grid) {
      const parsed = JSON.parse(grid) as string[]
      if (parsed.length === DEFAULT_GRID_ORDER.length && parsed.every(id => DEFAULT_GRID_ORDER.includes(id))) {
        gridCardOrder.value = parsed
      }
    }
  } catch { /* ignore */ }
}

function saveMainOrder() {
  localStorage.setItem(LS_KEY_MAIN_ORDER, JSON.stringify(mainCardOrder.value))
}

function saveGridOrder() {
  localStorage.setItem(LS_KEY_GRID_ORDER, JSON.stringify(gridCardOrder.value))
}

let dragCardId: string | null = null

function onDragStart(e: DragEvent, cardId: string) {
  dragCardId = cardId
  const el = e.target as HTMLElement
  el.classList.add("dragging")
  if (e.dataTransfer) {
    e.dataTransfer.setData("text/plain", cardId)
    e.dataTransfer.effectAllowed = "move"
  }
}

function onDragEnd(e: DragEvent) {
  (e.target as HTMLElement).classList.remove("dragging")
  dragCardId = null
}

function onDragOver(e: DragEvent, orderRef: 'main' | 'grid') {
  e.preventDefault()
  if (!dragCardId) return
  const target = (e.target as HTMLElement).closest("[data-card-id]") as HTMLElement | null
  if (!target) return
  const targetId = target.dataset.cardId
  if (!targetId || targetId === dragCardId) return
  const list = orderRef === 'main' ? mainCardOrder.value : gridCardOrder.value
  const fromIndex = list.indexOf(dragCardId)
  const toIndex = list.indexOf(targetId)
  if (fromIndex === -1 || toIndex === -1) return
  const next = [...list]
  next.splice(fromIndex, 1)
  next.splice(toIndex, 0, dragCardId)
  if (orderRef === 'main') {
    mainCardOrder.value = next
    saveMainOrder()
    /** 拖拽过程中实时移动 DOM 元素 */
    moveDomCard(dragCardId, target, orderRef)
  } else {
    gridCardOrder.value = next
    saveGridOrder()
    moveDomCard(dragCardId, target, orderRef)
  }
}

/** 在 DOM 中移动卡片元素到目标元素之前 */
function moveDomCard(cardId: string, targetEl: HTMLElement, orderRef: 'main' | 'grid') {
  const container = orderRef === 'main' ? document.querySelector('.dashboard') : document.querySelector('.detail-grid')
  if (!container) return
  const dragEl: HTMLElement | null = container.querySelector(`[data-card-id="${cardId}"]`)
  if (!dragEl) return
  container.insertBefore(dragEl, targetEl)
}

/** 按排序数组重排所有卡片 DOM 位置 */
function applyCardOrder() {
  const dashboard = document.querySelector('.dashboard')
  if (!dashboard) return

  /** 主卡片：插入到 grid 之前，按 mainCardOrder 顺序排列 */
  const gridSection = dashboard.querySelector('[data-card-id="grid-section"]')
  for (const cardId of mainCardOrder.value) {
    const el = dashboard.querySelector(`[data-card-id="${cardId}"]`)
    if (el && el.parentElement === dashboard) {
      dashboard.insertBefore(el, gridSection)
    }
  }

  /** 网格卡片：在 detail-grid 内按 gridCardOrder 顺序排列 */
  const grid = dashboard.querySelector('.detail-grid')
  if (!grid) return
  for (const cardId of gridCardOrder.value) {
    const el: HTMLElement | null = grid.querySelector(`[data-card-id="${cardId}"]`)
    if (el) grid.appendChild(el)
  }
}

/** 甘特图刷新定时器：每秒刷新一次让 running 请求的横线延伸到当前时刻 */
let ganttTimer: ReturnType<typeof setInterval> | null = null

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
  initGanttChart()
  loadTokenTrend()
  loadGroupTokenStats()
  loadCollapsedState()
  loadCardOrder()
  applyCardOrder()
  connectSSE()
  cleanupTimer = setInterval(cleanupCompleted, 30000)
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
  ganttTimer = setInterval(renderGanttChart, 1000)

  themeObserver = new MutationObserver(() => {
    chartInstance?.destroy()
    chartInstance = null
    ganttInstance?.destroy()
    ganttInstance = null
    tokenChartInstance?.destroy()
    tokenChartInstance = null
    initGanttChart()
    loadTokenTrend()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
})

onUnmounted(() => {
  disconnectSSE()
  if (tokenTrendTimer) clearTimeout(tokenTrendTimer)
  chartInstance?.destroy()
  ganttInstance?.destroy()
  tokenChartInstance?.destroy()
  themeObserver?.disconnect()
  if (cleanupTimer) clearInterval(cleanupTimer)
  if (clockTimer) clearInterval(clockTimer)
  if (ganttTimer) clearInterval(ganttTimer)
})

/** KeepAlive deactivate：暂停 SSE、定时器以节省资源 */
onDeactivated(() => {
  disconnectSSE()
  if (tokenTrendTimer) { clearTimeout(tokenTrendTimer); tokenTrendTimer = null }
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null }
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
  if (ganttTimer) { clearInterval(ganttTimer); ganttTimer = null }
})

/** KeepAlive activate：恢复 SSE 和定时器（保留已有数据，不清空图表） */
onActivated(() => {
  if (!info.value) return
  connectSSE()
  cleanupTimer = setInterval(cleanupCompleted, 30000)
  clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
  ganttTimer = setInterval(renderGanttChart, 1000)
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

/** 甘特图初始化：浮动柱状图实现请求时间线 */
function initGanttChart() {
  if (!ganttCanvas.value) return
  const ctx = ganttCanvas.value.getContext("2d")
  if (!ctx) return
  const style = getComputedStyle(document.documentElement)
  const textDim = style.getPropertyValue("--text-dim").trim() || "#888"
  const border = style.getPropertyValue("--border").trim() || "#2a2a2a"
  /** 主文本色：悬停描边用它，深浅主题下都有足够对比度 */
  const textMain = style.getPropertyValue("--text").trim() || "#1a1a1a"

  /**
   * 自定义插件：失败请求整块警告样式。
   * 成功请求不做任何状态标识（内部 token 堆叠即全部信息）；
   * 失败请求用红色半透明底 + 红色边框 + 斜纹覆盖，强警示。
   */
  const errorBarPlugin = {
    id: "errorBar",
    afterDatasetsDraw(chart: Chart) {
      const ctx = chart.ctx
      ctx.save()
      /** 每个请求一个 dataset，dataset 0 是速率折线（跳过），从 1 开始 */
      for (let d = 1; d < chart.data.datasets.length; d++) {
        const meta = chart.getDatasetMeta(d)
        const req = (chart.data.datasets[d] as Record<string, unknown>)._request as GanttRequest | undefined
        if (!meta.data.length || req?.status !== "error") continue
        /** 数据行是 null 占位到泳道行的，必须按实际数据的索引取柱子，不能取 data[0] */
        const dsData = chart.data.datasets[d]!.data as unknown[]
        const idx = dsData.findIndex(v => v !== null && v !== undefined)
        if (idx === -1) continue
        const bar = meta.data[idx] as unknown as { x: number; base: number; y: number; width: number; height: number } | undefined
        if (!bar) continue
        const left = Math.min(bar.x, bar.base)
        const top = bar.y - bar.height / 2
        /** 红色斜纹填充：45° 条纹铺满整个甘特条 */
        ctx.beginPath()
        ctx.rect(left, top, bar.width, bar.height)
        ctx.clip()
        ctx.strokeStyle = "rgba(239, 68, 68, 0.75)"
        ctx.lineWidth = 2
        const step = 6
        for (let x = left - bar.height; x < left + bar.width; x += step) {
          ctx.beginPath()
          ctx.moveTo(x, top + bar.height)
          ctx.lineTo(x + bar.height, top)
          ctx.stroke()
        }
        ctx.restore()
        ctx.save()
        /** 红色边框包住整块 */
        ctx.strokeStyle = "#ef4444"
        ctx.lineWidth = 1.5
        ctx.strokeRect(left, top, bar.width, bar.height)
      }
      ctx.restore()
    },
  }

  /**
   * 自定义插件：甘特条内部按 token 构成以"小方格"填充（华夫图式）。
   * 格子按条块像素尺寸自适应：每格目标 ~4×4px，条块越长格子越多、不设上限，
   * 格数 = 占比 × 总格数 —— 离散格子可直接数"输出占了几格"。
   */
  const tokenBarPlugin = {
    id: "tokenBar",
    afterDatasetsDraw(chart: Chart) {
      const ctx = chart.ctx
      ctx.save()
      /** dataset 0 是速率折线（跳过），从 1 开始是请求甘特条 */
      for (let d = 1; d < chart.data.datasets.length; d++) {
        const meta = chart.getDatasetMeta(d)
        const req = (chart.data.datasets[d] as Record<string, unknown>)._request as GanttRequest | undefined
        if (!meta.data.length || !req?.tokenUsage) continue
        const u = req.tokenUsage
        const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens
        if (total <= 0) continue
        /** 找到实际数据索引（数据行是 null 占位到泳道行的） */
        const dsData = chart.data.datasets[d]!.data as unknown[]
        const idx = dsData.findIndex(v => v !== null && v !== undefined)
        if (idx === -1) continue
        const bar = meta.data[idx] as unknown as { x: number; base: number; y: number; width: number; height: number } | undefined
        if (!bar) continue
        const left = Math.min(bar.x, bar.base)
        const top = bar.y - bar.height / 2
        /** 网格规模：每格目标 ~4px，纯面积驱动——条越长格越多，无上限 */
        const rows = Math.max(1, Math.floor(bar.height / 4))
        const cols = Math.max(1, Math.floor(bar.width / 4))
        const nCells = rows * cols
        if (nCells <= 0) continue
        /** 段顺序与趋势图配色一致：输入=琥珀 输出=红 缓存读=绿 缓存写=蓝 */
        const segments: [number, string][] = [
          [u.inputTokens, "rgba(245, 158, 11, 0.9)"],
          [u.outputTokens, "rgba(239, 68, 68, 0.9)"],
          [u.cacheReadTokens, "rgba(34, 197, 94, 0.9)"],
          [u.cacheCreationTokens, "rgba(59, 130, 246, 0.9)"],
        ]
        /** 累计占比切格：保证各段格数之和恰好 = 总格数；非零段至少 1 格 */
        let cum = 0
        let prevBound = 0
        const segRanges: { start: number; end: number; color: string }[] = []
        for (const [count, color] of segments) {
          if (count <= 0) continue
          cum += count
          let bound = Math.round((cum / total) * nCells)
          if (bound <= prevBound) bound = prevBound + 1
          segRanges.push({ start: prevBound, end: Math.min(bound, nCells), color })
          prevBound = Math.min(bound, nCells)
          if (prevBound >= nCells) break
        }
        /** 逐格填充：格序号 row-major，自下而上逐行、行内从左到右；同块内铺满不留缝 */
        const cw = bar.width / cols
        const ch = bar.height / rows
        for (const seg of segRanges) {
          ctx.fillStyle = seg.color
          for (let i = seg.start; i < seg.end; i++) {
            const row = Math.floor(i / cols)
            const col = i % cols
            const x = left + col * cw
            const y = top + bar.height - (row + 1) * ch
            ctx.fillRect(x, y, cw + 0.5, ch + 0.5)
          }
        }
      }
      ctx.restore()
    },
  }

  /**
   * 自定义插件：悬停高亮。
   * 鼠标所在请求的甘特条外围绘制高对比描边 + 同色罩层——
   * token 方格填充会盖住柱子本身的 hover 配色，罩层+描边保证任何柱子都有明确反馈。
   */
  const hoverHighlightPlugin = {
    id: "hoverHighlight",
    afterDatasetsDraw(chart: Chart) {
      if (!ganttHoverId) return
      const ctx = chart.ctx
      ctx.save()
      for (let d = 1; d < chart.data.datasets.length; d++) {
        const req = (chart.data.datasets[d] as Record<string, unknown>)._request as GanttRequest | undefined
        if (req?.requestId !== ganttHoverId) continue
        const meta = chart.getDatasetMeta(d)
        const dsData = chart.data.datasets[d]!.data as unknown[]
        const idx = dsData.findIndex(v => v !== null && v !== undefined)
        if (idx === -1) continue
        const bar = meta.data[idx] as unknown as { x: number; base: number; y: number; width: number; height: number } | undefined
        if (!bar) continue
        const left = Math.min(bar.x, bar.base)
        const top = bar.y - bar.height / 2
        ctx.fillStyle = getStableColor(req.providerId) + "40"
        ctx.fillRect(left, top, bar.width, bar.height)
        ctx.strokeStyle = textMain
        ctx.lineWidth = 2
        ctx.strokeRect(left - 1.5, top - 1.5, bar.width + 3, bar.height + 3)
        break
      }
      ctx.restore()
    },
  }

  ganttInstance = new Chart(ctx, {
    type: "bar",
    data: { labels: [], datasets: [] },
    plugins: [errorBarPlugin, tokenBarPlugin, hoverHighlightPlugin],
    options: {
      indexAxis: "y" as const,
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      /** 空白区域的事件不拦截，泳道行少时柱子不会挤在半张图里 */
      spanGaps: true,
      /** 悬停追踪：记录所在请求 ID 供高亮插件使用，并切换指针样式 */
      onHover: (event: unknown, elements: { datasetIndex: number }[]) => {
        const el = elements[0]
        const ds = el && el.datasetIndex > 0
          ? ganttInstance?.data.datasets[el.datasetIndex] as Record<string, unknown> | undefined
          : undefined
        const next = (ds?._request as GanttRequest | undefined)?.requestId ?? null
        if (next !== ganttHoverId) ganttHoverId = next
        const native = (event as { native?: { target?: { style?: CSSStyleDeclaration } } }).native
        if (native?.target?.style) native.target.style.cursor = next ? "pointer" : "default"
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item: { datasetIndex: number }) => item.datasetIndex > 0,
          callbacks: {
            /** 标题：请求模型 → 实际模型 */
            title: (items: { dataset: Record<string, unknown> }[]) => {
              const req = items[0]?.dataset._request as GanttRequest | undefined
              if (!req) return ""
              return `${req.model} → ${req.targetModel}`
            },
            label: (item: { dataset: Record<string, unknown>; raw: unknown }) => {
              const req = item.dataset._request as GanttRequest | undefined
              if (!req) return ""
              const lines: string[] = []
              const timeRange = item.raw as [number, number]
              const nowMs = Date.now()
              const isRunning = req.endedAt === null
              const dur = isRunning ? nowMs - req.startedAt : (req.durationMs || timeRange[1] - timeRange[0])

              /** 状态行 */
              const statusText = isRunning ? t("dashboard.running") : req.status === "error" ? `${t("dashboard.filterError")} ${req.statusCode}` : `${t("dashboard.filterDone")} ${req.statusCode}`
              lines.push(`${t("dashboard.ganttProvider")}: ${req.provider}  |  ${statusText}`)
              /** 耗时 */
              lines.push(`${t("dashboard.duration")}: ${formatDuration(dur)}${isRunning ? " ⏳" : ""}`)
              /** 时间区间 */
              lines.push(`${t("dashboard.startedAt")}: ${new Date(req.startedAt).toLocaleTimeString()} → ${isRunning ? t("dashboard.running") : new Date(req.endedAt!).toLocaleTimeString()}`)
              /** Token 消耗（request_end 后才有），带构成占比 */
              if (req.tokenUsage) {
                const u = req.tokenUsage
                const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens
                const pct = (n: number) => total > 0 ? ` (${Math.round(n / total * 100)}%)` : ""
                const parts = [
                  `in ${formatNumber(u.inputTokens)}${pct(u.inputTokens)}`,
                  `out ${formatNumber(u.outputTokens)}${pct(u.outputTokens)}`,
                ]
                if (u.cacheReadTokens > 0) parts.push(`cache-r ${formatNumber(u.cacheReadTokens)}${pct(u.cacheReadTokens)}`)
                if (u.cacheCreationTokens > 0) parts.push(`cache-w ${formatNumber(u.cacheCreationTokens)}${pct(u.cacheCreationTokens)}`)
                lines.push(`Token: ${parts.join(" / ")}`)
              }
              /** 错误信息 */
              if (req.error) {
                lines.push(`${t("dashboard.filterError")}: ${truncate(req.error, 120)}`)
              }
              return lines
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          position: "bottom",
          /** 数值 min/max：每秒渲染时由 renderGanttChart 更新（真实时间窗口） */
          min: 0,
          max: 1,
          ticks: {
            color: textDim,
            font: { size: 10 },
            maxTicksLimit: 8,
            callback: (v: number) => {
              const d = new Date(v)
              return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
            },
          },
          grid: { color: border },
          title: { display: true, text: t("dashboard.ganttTimeAxis"), color: textDim, font: { size: 11 } },
        },
        y: {
          type: "category",
          ticks: { display: false },
          grid: { color: border },
        },
        y1: {
          type: "linear",
          position: "right",
          beginAtZero: true,
          title: { display: true, text: t("dashboard.outputRateLabel"), color: textDim, font: { size: 10 } },
          ticks: { color: textDim, font: { size: 10 }, maxTicksLimit: 5 },
          grid: { drawOnChartArea: false },
        },
      },
    },
  })
}

/** 从后端历史快照恢复速率数据（SSE 重连时回放，快照间隔 1s） */
function restoreHistory(snapshots: { time: string; providers: { id: string; name: string; color?: string; gateway: number; upstream: number }[]; outputRate: number }[]) {
  outputRateHistory.length = 0
  const nowTs = Date.now()
  /** 快照是秒级等间隔的，从最新一个往前推时间戳 */
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[snapshots.length - 1 - i]!
    outputRateHistory.unshift({ ts: nowTs - i * 1000, rate: snap.outputRate })
  }
  while (outputRateHistory.length > maxRatePoints) outputRateHistory.shift()
  renderGanttChart()
}

/** 追加单个实时输出速率采样 */
function appendChartPoint(outputRate: number) {
  outputRateHistory.push({ ts: Date.now(), rate: outputRate })
  if (outputRateHistory.length > maxRatePoints) outputRateHistory.shift()
  renderGanttChart()
}

/** 渲染甘特图：泳道式布局——时间不重叠的请求放同一行，重叠的分配新行 */
function renderGanttChart() {
  if (!ganttInstance) return
  const nowMs = Date.now()
  const cutoff = nowMs - GANTT_WINDOW_MS

  /** 纯真实时间轴：起点在窗口内的请求可见（running 请求始终可见） */
  const visible = [...ganttRequests.value.values()]
    .filter(r => r.startedAt >= cutoff || r.endedAt === null)
    .sort((a, b) => a.startedAt - b.startedAt)

  /** 泳道同步：持久化分配。只移除已不在追踪表里的条目，既有请求的行号永不重排 */
  for (const lane of ganttLanes) {
    for (let i = lane.length - 1; i >= 0; i--) {
      if (!ganttRequests.value.has(lane[i]!.id)) lane.splice(i, 1)
    }
  }
  for (const [id, li] of ganttLaneOf) {
    if (!ganttRequests.value.has(id)) ganttLaneOf.delete(id)
  }
  /** 尾部空泳道才裁剪：不影响任何既有行号 */
  while (ganttLanes.length > 0 && ganttLanes[ganttLanes.length - 1]!.length === 0) ganttLanes.pop()

  for (const r of visible) {
    const end = r.endedAt ?? nowMs
    const li = ganttLaneOf.get(r.requestId)
    if (li !== undefined) {
      const entry = ganttLanes[li]?.find(e => e.id === r.requestId)
      if (entry) {
        /** 已有分配：只延长/修正区间，绝不换行 */
        entry.start = r.startedAt
        entry.end = Math.max(entry.end, end)
        continue
      }
      ganttLaneOf.delete(r.requestId)
    }
    /** 新请求：找第一条无时间冲突的泳道，全满则追加新行 */
    let assigned = -1
    for (let i = 0; i < ganttLanes.length; i++) {
      const conflicts = ganttLanes[i]!.some(e => {
        /** running 请求的甘特条持续向右延伸，冲突判定时视作开放区间（Infinity）：
         *  否则"上一帧的 now"与"本帧新请求的 startedAt"比较会误判为不冲突，
         *  并发请求被塞进同一行，两根同时延伸的柱子完全重叠 */
        const er = ganttRequests.value.get(e.id)
        const eEnd = er && er.endedAt === null ? Infinity : e.end
        const rEnd = r.endedAt === null ? Infinity : end
        return r.startedAt < eEnd && rEnd > e.start
      })
      if (!conflicts) { assigned = i; break }
    }
    if (assigned === -1) {
      ganttLanes.push([])
      assigned = ganttLanes.length - 1
    }
    ganttLanes[assigned]!.push({ id: r.requestId, start: r.startedAt, end })
    ganttLaneOf.set(r.requestId, assigned)
  }

  /** 按泳道索引构建 Y 轴标签（泳道 0 在顶部） */
  const laneLabels: string[] = []
  for (let i = 0; i < ganttLanes.length; i++) laneLabels.push(String(i))

  /**
   * 每个请求一个 dataset：柱子的行位置由"数据索引 ↔ 标签索引"决定，
   * 每行数据里放 null 占位到自己的泳道行，配合 grouped:false 让不同 dataset 的柱子叠绘在同一行内。
   */
  const datasets: Record<string, unknown>[] = []
  for (const r of visible) {
    const laneIdx = ganttLaneOf.get(r.requestId) ?? 0
    const end = r.endedAt ?? nowMs
    /** null 占位到目标行，柱子只出现在自己的泳道；直接用真实时间戳 */
    const row: ([number, number] | null)[] = new Array(ganttLanes.length).fill(null)
    row[laneIdx] = [r.startedAt, Math.max(end, r.startedAt + 100)]
    const pc = getStableColor(r.providerId)
    datasets.push({
      data: row,
      backgroundColor: pc + "50",
      borderColor: pc,
      borderWidth: 1,
      borderSkipped: false,
      grouped: false,
      barPercentage: 0.7,
      categoryPercentage: 0.8,
      yAxisID: "y",
      stack: `req-${r.requestId}`,
      /** 携带请求引用供 tooltip 与失败样式插件使用 */
      _request: r,
    })  }

  /** 输出速率折线：采样时间戳直接落在真实时间轴上 */
  const rateData = outputRateHistory.map(s => ({ x: s.ts, y: s.rate }))
  datasets.push({
    label: t("dashboard.outputRateLabel"),
    data: rateData,
    borderColor: "#f472b6",
    backgroundColor: "transparent",
    type: "line",
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
    yAxisID: "y1",
    order: 0,
  } as never)

  /** 真实时间窗口：恒定 [now-30min, now]，每秒平滑左移，历史柱子零跳动 */
  const xScale = ganttInstance.options.scales!.x as { min: number; max: number }
  xScale.min = cutoff
  xScale.max = nowMs

  ganttInstance.data.labels = laneLabels
  ganttInstance.data.datasets = datasets as never
  ganttInstance.update("none")
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

function disconnectSSE() {
  if (sseUnsubscribe) { sseUnsubscribe(); sseUnsubscribe = null }
}

function connectSSE() {
  disconnectSSE()

  sseUnsubscribe = subscribeSSE((event) => {
    if (event.type === "concurrency_history") {
      restoreHistory(event.snapshots)
    } else if (event.type === "gantt_history") {
      /** 服务端甘特缓冲区回放：刷新后恢复时间线，Map 按 requestId 去重 */
      for (const r of event.requests) {
        ganttRequests.value.set(r.requestId, {
          requestId: r.requestId,
          model: r.model,
          targetModel: r.targetModel,
          provider: r.provider,
          providerId: r.providerId,
          startedAt: r.startedAt,
          endedAt: r.endedAt,
          status: r.status,
          statusCode: r.statusCode,
          error: r.error,
          durationMs: r.durationMs,
          tokenUsage: r.tokenUsage,
        })
      }
      renderGanttChart()
    } else if (event.type === "concurrency") {
      providerConcurrency.value = event.providers
      appendChartPoint(event.outputRate)
    } else if (event.type === "output_rate") {
      /** 原位更新最新采样的速率值：折线实时平滑移动 */
      if (outputRateHistory.length) {
        outputRateHistory[outputRateHistory.length - 1]!.rate = event.rate
        renderGanttChart()
      }
    } else if (event.type === "request_start") {
      const nowMs = Date.now()
      liveRequests.value.set(event.requestId, {
        requestId: event.requestId,
        model: event.model,
        targetModel: event.targetModel,
        provider: event.provider,
        providerId: event.providerId ?? "",
        fallbackProvider: null,
        input: event.input,
        output: event.output ?? "",
        status: "running",
        durationMs: 0,
        statusCode: 0,
        error: null,
        startedAt: event.startedAt ?? nowMs,
        rulePattern: event.rulePattern ?? null,
        keyName: event.keyName ?? null,
        groupName: event.groupName ?? null,
        tokenUsage: null,
        _scrollTimer: null,
      })
      /** 甘特图：新增请求（Map 天然去重，SSE 重连重放不会产生重复条目） */
      ganttRequests.value.set(event.requestId, {
        requestId: event.requestId,
        model: event.model,
        targetModel: event.targetModel,
        provider: event.provider,
        providerId: event.providerId ?? "",
        startedAt: event.startedAt ?? nowMs,
        endedAt: null,
        status: "running",
        statusCode: 0,
        error: null,
        durationMs: 0,
        tokenUsage: null,
      })
      if (ganttRequests.value.size > GANTT_MAX_REQUESTS) {
        /** 淘汰最早开始的请求 */
        let oldestId: string | null = null
        let oldestTs = Infinity
        for (const [id, r] of ganttRequests.value) {
          if (r.startedAt < oldestTs) { oldestTs = r.startedAt; oldestId = id }
        }
        if (oldestId) ganttRequests.value.delete(oldestId)
      }
      renderGanttChart()
    } else if (event.type === "request_stream") {
      const req = liveRequests.value.get(event.requestId)
      if (req) {
        /** 截断过长输出防止浏览器内存膨胀 */
        if (req.output.length < 50000) req.output += event.text
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
      /** 甘特图同步：fallback 切换后横线颜色跟随实际服务的提供商 */
      const gReq = ganttRequests.value.get(event.requestId)
      if (gReq && event.providerId && event.providerId !== gReq.providerId) {
        gReq.providerId = event.providerId
        if (event.providerName) gReq.provider = event.providerName
        renderGanttChart()
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
      /** 甘特图：更新请求结束时间和状态 */
      const gReq = ganttRequests.value.get(event.requestId)
      if (gReq) {
        gReq.endedAt = Date.now()
        gReq.status = event.error ? "error" : "done"
        gReq.statusCode = event.statusCode
        gReq.error = event.error
        gReq.durationMs = event.durationMs
        if (event.tokenUsage) {
          gReq.tokenUsage = { inputTokens: event.tokenUsage.inputTokens ?? 0, outputTokens: event.tokenUsage.outputTokens ?? 0, cacheCreationTokens: event.tokenUsage.cacheCreationTokens ?? 0, cacheReadTokens: event.tokenUsage.cacheReadTokens ?? 0 }
        }
      }
      renderGanttChart()
      /** 输出字符速率已通过 request_stream 实时累加 */
      scheduleTokenTrendRefresh()
    } else if (event.type === "request_stats") {
      if (!info.value) return
      info.value.requests = event.requests
      info.value.requestsByProvider = event.byProvider
      info.value.requestsByModel = event.byModel
      if (event.tokenStats) {
        info.value.tokenStats = event.tokenStats
      }
      if (event.tokensByProvider) {
        info.value.tokensByProvider = event.tokensByProvider
      }
      if (event.tokensByModel) {
        info.value.tokensByModel = event.tokensByModel
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
      /** 甘特图同步标记超时 */
      const gReq = ganttRequests.value.get(id)
      if (gReq) {
        gReq.endedAt = cutoff
        gReq.status = "error"
        gReq.error = "Timed out"
      }
    }
  }
  /** 甘特图：清理超出时间窗口的旧请求（保留 running，它们仍要延伸显示） */
  const ganttCutoff = cutoff - GANTT_WINDOW_MS
  for (const [id, r] of ganttRequests.value) {
    if (r.startedAt < ganttCutoff && r.endedAt !== null) ganttRequests.value.delete(id)
  }
  renderGanttChart()
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
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.uptime') }}</span>{{ formatUptime(info.uptime) }}</span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.providers') }}</span>{{ info.providers.enabled }} / {{ info.providers.total }}</span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.routes') }}</span>{{ info.routeRules }}</span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.totalRequests') }}</span>{{ info.requests.total }}</span>
        <span class="stat-item"><span class="stat-label">{{ t('dashboard.today') }}</span>{{ info.requests.today }}</span>
        <span class="stat-item" v-if="info.requests.today > 0" :style="{ color: info.requests.todayErrors > 0 ? 'var(--err)' : undefined }"><span class="stat-label">{{ t('dashboard.errorRate') }}</span>{{ info.requests.todayErrors }} ({{ (info.requests.todayErrors / Math.max(info.requests.today, 1) * 100).toFixed(1) }}%)</span>
        <span class="stat-item" v-if="info.requests.todayAvgMs > 0"><span class="stat-label">{{ t('dashboard.avgLatency') }}</span>{{ formatDuration(info.requests.todayAvgMs) }}</span>
        <span class="stat-item" v-if="info.requests.todayP50Ms > 0"><span class="stat-label">P50</span>{{ formatDuration(info.requests.todayP50Ms) }}</span>
        <span class="stat-item" v-if="info.requests.todayP95Ms > 0"><span class="stat-label">P95</span>{{ formatDuration(info.requests.todayP95Ms) }}</span>
        <span class="stat-item" v-if="info.requests.todayP99Ms > 0"><span class="stat-label">P99</span>{{ formatDuration(info.requests.todayP99Ms) }}</span>
        <span class="stat-item" :title="info.tokenStats?.today ? `${t('dashboard.inputCol')}: ${formatNumber(info.tokenStats.today.inputTokens)}\n${t('dashboard.outputCol')}: ${formatNumber(info.tokenStats.today.outputTokens)}${info.tokenStats.today.cacheReadTokens ? `\n${t('dashboard.cacheReadCol')}: ${formatNumber(info.tokenStats.today.cacheReadTokens)}` : ''}${info.tokenStats.today.cacheCreationTokens ? `\n${t('dashboard.cacheWriteCol')}: ${formatNumber(info.tokenStats.today.cacheCreationTokens)}` : ''}` : undefined"><span class="stat-label">{{ t('dashboard.todayTokens') }}</span>{{ formatTokenCount(info.tokenStats?.today) }}</span>
        <span class="stat-item" :title="info.tokenStats?.total ? `${t('dashboard.inputCol')}: ${formatNumber(info.tokenStats.total.inputTokens)}\n${t('dashboard.outputCol')}: ${formatNumber(info.tokenStats.total.outputTokens)}${info.tokenStats.total.cacheReadTokens ? `\n${t('dashboard.cacheReadCol')}: ${formatNumber(info.tokenStats.total.cacheReadTokens)}` : ''}${info.tokenStats.total.cacheCreationTokens ? `\n${t('dashboard.cacheWriteCol')}: ${formatNumber(info.tokenStats.total.cacheCreationTokens)}` : ''}` : undefined"><span class="stat-label">{{ t('dashboard.totalTokens') }}</span>{{ formatTokenCount(info.tokenStats?.total) }}</span>
      </div>

      <!-- 并发 + 输出速率监控 -->
      <div class="detail-card" :style="{ order: mainCardOrder.indexOf('concurrency') }" data-card-id="concurrency" draggable="true"
           @dragstart="onDragStart($event, 'concurrency')" @dragend="onDragEnd" @dragover="onDragOver($event, 'main')">
        <div class="card-header-row">
          <h3>{{ t('dashboard.concurrencyOutputRate') }}</h3>
          <button class="btn-collapse" @click="toggleCollapse('concurrency')">{{ isCollapsed('concurrency') ? '▶' : '▼' }}</button>
        </div>
        <div v-show="!isCollapsed('concurrency')">
          <div class="chart-container">
            <canvas ref="ganttCanvas"></canvas>
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
      </div>

      <!-- SKU 用量统计 -->
      <div class="detail-card" :style="{ order: mainCardOrder.indexOf('sku-usage') }" data-card-id="sku-usage" draggable="true"
           @dragstart="onDragStart($event, 'sku-usage')" @dragend="onDragEnd" @dragover="onDragOver($event, 'main')">
        <div class="card-header-row">
          <h3>{{ t('skuUsage.title') }}</h3>
          <button class="btn-collapse" @click="toggleCollapse('sku-usage')">{{ isCollapsed('sku-usage') ? '▶' : '▼' }}</button>
        </div>
        <div v-show="!isCollapsed('sku-usage')">
          <SkuUsageWidget />
        </div>
      </div>

      <!-- Token 用量趋势 -->
      <div class="detail-card" :style="{ order: mainCardOrder.indexOf('token-trend') }" data-card-id="token-trend" draggable="true"
           @dragstart="onDragStart($event, 'token-trend')" @dragend="onDragEnd" @dragover="onDragOver($event, 'main')">
        <div class="card-header-row">
          <h3>{{ t('dashboard.tokenTrend') }}</h3>
          <button class="btn-collapse" @click="toggleCollapse('token-trend')">{{ isCollapsed('token-trend') ? '▶' : '▼' }}</button>
        </div>
        <div v-show="!isCollapsed('token-trend')">
          <div class="range-tabs" style="margin-bottom: 12px;">
            <button
              v-for="opt in tokenTrendOptions"
              :key="opt.value"
              :class="['range-tab', { active: tokenTrendHours === opt.value }]"
              @click="setTokenTrendRange(opt.value)"
            >{{ opt.label }}</button>
          </div>
          <div class="chart-container">
            <canvas ref="tokenTrendCanvas"></canvas>
          </div>
        </div>
      </div>

      <!-- 实时请求日志 -->
      <div class="detail-card" :style="{ order: mainCardOrder.indexOf('live-requests') }" data-card-id="live-requests" draggable="true"
           @dragstart="onDragStart($event, 'live-requests')" @dragend="onDragEnd" @dragover="onDragOver($event, 'main')">
        <div class="card-header-row">
          <h3>{{ t('dashboard.liveRequests') }}</h3>
          <div style="display: flex; gap: 8px; align-items: center;">
            <div class="filter-tabs" v-if="completedRequests.length > 0">
              <button :class="['filter-tab', { active: requestFilter === 'all' }]" @click="requestFilter = 'all'">{{ t('dashboard.filterAll') }}</button>
              <button :class="['filter-tab', { active: requestFilter === 'done' }]" @click="requestFilter = 'done'">{{ t('dashboard.filterDone') }}</button>
              <button :class="['filter-tab', { active: requestFilter === 'error' }]" @click="requestFilter = 'error'">{{ t('dashboard.filterError') }}</button>
              <button class="filter-tab" @click="completedRequests = []">✕</button>
            </div>
            <button class="btn-collapse" @click="toggleCollapse('live-requests')">{{ isCollapsed('live-requests') ? '▶' : '▼' }}</button>
          </div>
        </div>
        <div v-show="!isCollapsed('live-requests')" class="live-logs" ref="liveLogsRef">
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

      <div class="detail-grid" data-card-id="grid-section">
        <div class="detail-card" :style="{ order: gridCardOrder.indexOf('provider-stats') }" data-card-id="provider-stats" draggable="true"
             @dragstart="onDragStart($event, 'provider-stats')" @dragend="onDragEnd" @dragover="onDragOver($event, 'grid')">
          <div class="card-header-row">
            <h3>{{ t('dashboard.providerStats') }}</h3>
            <button class="btn-collapse" @click="toggleCollapse('provider-stats')">{{ isCollapsed('provider-stats') ? '▶' : '▼' }}</button>
          </div>
          <div v-show="!isCollapsed('provider-stats')">
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
        </div>

        <div class="detail-card" :style="{ order: gridCardOrder.indexOf('model-stats') }" data-card-id="model-stats" draggable="true"
             @dragstart="onDragStart($event, 'model-stats')" @dragend="onDragEnd" @dragover="onDragOver($event, 'grid')">
          <div class="card-header-row">
            <h3>{{ t('dashboard.modelStats') }}</h3>
            <button class="btn-collapse" @click="toggleCollapse('model-stats')">{{ isCollapsed('model-stats') ? '▶' : '▼' }}</button>
          </div>
          <div v-show="!isCollapsed('model-stats')">
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
        </div>

        <div class="detail-card span-2" :style="{ order: gridCardOrder.indexOf('provider-token') }" data-card-id="provider-token" draggable="true"
             @dragstart="onDragStart($event, 'provider-token')" @dragend="onDragEnd" @dragover="onDragOver($event, 'grid')">
          <div class="card-header-row">
            <h3>{{ t('dashboard.providerTokenUsage') }}</h3>
            <button class="btn-collapse" @click="toggleCollapse('provider-token')">{{ isCollapsed('provider-token') ? '▶' : '▼' }}</button>
          </div>
          <div v-show="!isCollapsed('provider-token')">
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
        </div>

        <div class="detail-card span-2" :style="{ order: gridCardOrder.indexOf('model-token') }" data-card-id="model-token" draggable="true"
             @dragstart="onDragStart($event, 'model-token')" @dragend="onDragEnd" @dragover="onDragOver($event, 'grid')">
          <div class="card-header-row">
            <h3>{{ t('dashboard.modelTokenUsage') }}</h3>
            <button class="btn-collapse" @click="toggleCollapse('model-token')">{{ isCollapsed('model-token') ? '▶' : '▼' }}</button>
          </div>
          <div v-show="!isCollapsed('model-token')">
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
      </div>

      <!-- 分组 Token 用量 -->
      <div v-if="groupTokenStats.length" class="detail-card" :style="{ order: mainCardOrder.indexOf('group-token') }" data-card-id="group-token" draggable="true"
           @dragstart="onDragStart($event, 'group-token')" @dragend="onDragEnd" @dragover="onDragOver($event, 'main')">
        <div class="card-header-row">
          <h3>{{ t('dashboard.groupTokenUsage') }}</h3>
          <button class="btn-collapse" @click="toggleCollapse('group-token')">{{ isCollapsed('group-token') ? '▶' : '▼' }}</button>
        </div>
        <div v-show="!isCollapsed('group-token')">
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
      </div>

      <!-- 密钥 Token 用量 -->
      <div v-if="keyTokenStats.length" class="detail-card" :style="{ order: mainCardOrder.indexOf('key-token') }" data-card-id="key-token" draggable="true"
           @dragstart="onDragStart($event, 'key-token')" @dragend="onDragEnd" @dragover="onDragOver($event, 'main')">
        <div class="card-header-row">
          <h3>{{ t('dashboard.keyTokenUsage') }}</h3>
          <button class="btn-collapse" @click="toggleCollapse('key-token')">{{ isCollapsed('key-token') ? '▶' : '▼' }}</button>
        </div>
        <div v-show="!isCollapsed('key-token')">
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
  margin-bottom: 16px;
  min-width: 0;
  overflow: auto;
}

.detail-card.span-2 {
  grid-column: span 2;
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

.btn-collapse {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}

.btn-collapse:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.dragging {
  opacity: 0.5;
  border: 2px dashed var(--primary);
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
  font-size: 12px;
}
.detail-card .table th,
.detail-card .table td {
  padding: 8px 8px;
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

@media (max-width: 768px) {
  .log-header {
    flex-wrap: wrap;
    gap: 6px;
  }
  .log-status {
    margin-left: 0;
    width: 100%;
    text-align: right;
  }
  .log-item {
    padding: 8px 10px;
    font-size: 12px;
  }
  .chart-container {
    height: 160px;
  }
  .detail-card {
    padding: 14px 10px;
    overflow-x: auto;
  }
  .detail-card .table {
    min-width: 700px;
  }
  .log-token-detail {
    flex-wrap: wrap;
    gap: 8px;
  }
}

@media (max-width: 640px) {
  .stats-bar {
    font-size: 11px;
  }
  .concurrency-grid {
    gap: 8px;
  }
  .detail-grid {
    grid-template-columns: 1fr !important;
  }
  .detail-card.span-2 {
    grid-column: span 1;
  }
}
</style>

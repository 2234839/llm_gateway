<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue"
import { api } from "../api"
import { t } from "../i18n"
import { formatDuration, formatNumber } from "../format"
import { subscribeSSE } from "../sse-manager"

/** 慢查询日志条目 */
interface SlowQueryRecord {
  id: number
  at: string
  sql: string
  params: string
  durationMs: number
}

/** 按 SQL 聚合的高频慢点 */
interface SlowQueryAgg {
  sql: string
  count: number
  maxMs: number
  lastAt: string
}

interface SlowQueriesResponse {
  thresholdMs: number
  records: SlowQueryRecord[]
  aggregated: SlowQueryAgg[]
}

const thresholdMs = ref(100)
const records = ref<SlowQueryRecord[]>([])
const aggregated = ref<SlowQueryAgg[]>([])
const loading = ref(true)
const loadError = ref("")
/** 视图切换：日志明细 / 聚合排行 */
const view = ref<"records" | "agg">("agg")
/** 展开了 SQL 全文与参数的记录 id 集合 */
const expanded = ref<Set<number>>(new Set())
/** 阈值编辑 */
const editingThreshold = ref(false)
const thresholdInput = ref("100")
const savingThreshold = ref(false)

const unsubSSE = ref<(() => void) | null>(null)

/** 总慢查询次数（聚合视图合计） */
const totalSlow = computed(() => aggregated.value.reduce((s, a) => s + a.count, 0))

async function load() {
  loading.value = true
  loadError.value = ""
  try {
    const data = await api<SlowQueriesResponse>("/admin/slow-queries?limit=200")
    thresholdMs.value = data.thresholdMs
    records.value = data.records
    aggregated.value = data.aggregated
  } catch (e: unknown) {
    loadError.value = e instanceof Error ? e.message : "Failed to load"
  } finally {
    loading.value = false
  }
}

function toggleExpand(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function startEditThreshold() {
  thresholdInput.value = String(thresholdMs.value)
  editingThreshold.value = true
}

async function saveThreshold() {
  const ms = parseInt(thresholdInput.value, 10)
  if (Number.isNaN(ms)) return
  savingThreshold.value = true
  try {
    const data = await api<{ thresholdMs: number }>("/admin/slow-queries/threshold", { method: "PUT", body: JSON.stringify({ thresholdMs: ms }) })
    thresholdMs.value = data.thresholdMs
    editingThreshold.value = false
  } catch (e: unknown) {
    loadError.value = e instanceof Error ? e.message : "Save failed"
  } finally {
    savingThreshold.value = false
  }
}

function onSlowQuery() {
  /** 实时收到慢查询事件：轻量刷新（后台拉取，不打断当前视图） */
  void load()
}

onMounted(async () => {
  await load()
  unsubSSE.value = subscribeSSE((ev) => { if (ev.type === "slow_query") onSlowQuery() })
})

onUnmounted(() => {
  unsubSSE.value?.()
  unsubSSE.value = null
})
</script>

<template>
  <div class="slow-queries">
    <div class="toolbar">
      <div class="view-switch">
        <button :class="{ active: view === 'agg' }" @click="view = 'agg'">{{ t('slowQueries.aggView') }}</button>
        <button :class="{ active: view === 'records' }" @click="view = 'records'">{{ t('slowQueries.recordsView') }}</button>
      </div>
      <div class="spacer" />
      <div class="threshold">
        <span class="threshold-label">{{ t('slowQueries.threshold') }}</span>
        <template v-if="!editingThreshold">
          <strong>{{ formatNumber(thresholdMs) }}ms</strong>
          <button class="mini-btn" @click="startEditThreshold">{{ t('slowQueries.edit') }}</button>
        </template>
        <template v-else>
          <input v-model="thresholdInput" type="number" min="10" max="60000" @keyup.enter="saveThreshold" />
          <button class="mini-btn primary" :disabled="savingThreshold" @click="saveThreshold">{{ t('slowQueries.save') }}</button>
          <button class="mini-btn" @click="editingThreshold = false">{{ t('slowQueries.cancel') }}</button>
        </template>
      </div>
      <button class="mini-btn" @click="load">{{ t('slowQueries.refresh') }}</button>
    </div>

    <div v-if="loadError" class="error">{{ loadError }}</div>
    <div v-if="loading" class="loading">{{ t('slowQueries.loading') }}</div>

    <template v-else>
      <div v-if="records.length === 0" class="empty">
        {{ t('slowQueries.empty', { threshold: formatNumber(thresholdMs) }) }}
      </div>

      <!-- 聚合排行视图 -->
      <table v-else-if="view === 'agg'" class="data-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{{ t('slowQueries.colSql') }}</th>
            <th class="num">{{ t('slowQueries.colCount') }}</th>
            <th class="num">{{ t('slowQueries.colMaxMs') }}</th>
            <th>{{ t('slowQueries.colLastAt') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(a, i) in aggregated" :key="a.sql">
            <td>{{ i + 1 }}</td>
            <td class="sql-cell" :title="a.sql">{{ a.sql }}</td>
            <td class="num">{{ formatNumber(a.count) }}</td>
            <td class="num slow-ms">{{ formatDuration(a.maxMs) }}</td>
            <td class="dim">{{ a.lastAt.replace("T", " ").slice(0, 19) }}</td>
          </tr>
        </tbody>
      </table>

      <!-- 日志明细视图 -->
      <table v-else class="data-table">
        <thead>
          <tr>
            <th>{{ t('slowQueries.colTime') }}</th>
            <th class="num">{{ t('slowQueries.colDuration') }}</th>
            <th>{{ t('slowQueries.colSql') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in records" :key="r.id">
            <tr class="clickable" @click="toggleExpand(r.id)">
              <td class="dim">{{ r.at.replace("T", " ").slice(0, 19) }}</td>
              <td class="num slow-ms">{{ formatDuration(r.durationMs) }}</td>
              <td class="sql-cell" :title="r.sql">{{ r.sql }}</td>
            </tr>
            <tr v-if="expanded.has(r.id)">
              <td :colspan="3" class="detail-cell">
                <div class="detail-block">
                  <div class="detail-title">SQL</div>
                  <pre>{{ r.sql }}</pre>
                  <div class="detail-title">Params</div>
                  <pre>{{ r.params }}</pre>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped>
.slow-queries { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.spacer { flex: 1; }
.view-switch { display: flex; gap: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.view-switch button { border: none; background: transparent; padding: 5px 12px; cursor: pointer; color: var(--text-dim); }
.view-switch button.active { background: var(--accent); color: #fff; }
.threshold { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.threshold input { width: 80px; }
.mini-btn { font-size: 12px; padding: 3px 8px; cursor: pointer; }
.mini-btn.primary { font-weight: 600; }
.error { color: var(--danger, #e5484d); }
.loading, .empty { color: var(--text-dim, #888); padding: 24px 0; text-align: center; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th, .data-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); }
.data-table th.num, .data-table td.num { text-align: right; }
.data-table th { color: var(--text-dim); font-weight: 500; }
.sql-cell { font-family: var(--font-mono, monospace); max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slow-ms { color: var(--danger, #e5484d); font-weight: 600; font-family: var(--font-mono, monospace); }
.dim { color: var(--text-dim, #888); }
tr.clickable { cursor: pointer; }
tr.clickable:hover { background: var(--hover, rgba(128,128,128,.08)); }
.detail-cell { background: var(--bg-secondary, rgba(128,128,128,.05)); }
.detail-block { padding: 8px 4px; }
.detail-title { font-size: 11px; color: var(--text-dim); margin: 8px 0 2px; }
.detail-block pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 12px; }
</style>

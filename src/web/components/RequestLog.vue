<script setup lang="ts">
import { ref, onMounted } from "vue"
import { logApi, type LogEntry } from "../api"

const logs = ref<LogEntry[]>([])
const loading = ref(true)
const offset = ref(0)
const limit = 50
const expandedId = ref<number | null>(null)

onMounted(load)

async function load() {
  loading.value = true
  logs.value = await logApi.list({ limit, offset: offset.value })
  loading.value = false
}

async function prev() {
  offset.value = Math.max(0, offset.value - limit)
  await load()
}

async function next() {
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

function toggleExpand(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}
</script>

<template>
  <div class="request-log">
    <div class="toolbar">
      <h2>请求日志</h2>
      <button class="btn" @click="load">刷新</button>
    </div>

    <div v-if="loading" class="loading">加载中...</div>

    <div v-else>
      <table class="table">
        <thead>
          <tr>
            <th>时间</th>
            <th>模型</th>
            <th>服务商</th>
            <th>目标模型</th>
            <th>流式</th>
            <th>状态</th>
            <th>耗时</th>
            <th>令牌数</th>
            <th>错误</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="log in logs" :key="log.id">
            <tr class="log-row" @click="toggleExpand(log.id)">
              <td class="mono">{{ formatTime(log.timestamp) }}</td>
              <td><code>{{ log.model }}</code></td>
              <td>{{ log.providerId }}</td>
              <td><code>{{ log.targetModel }}</code></td>
              <td>{{ log.stream ? "是" : "否" }}</td>
              <td :class="statusClass(log.statusCode)">{{ log.statusCode }}</td>
              <td>{{ log.durationMs }}ms</td>
              <td>{{ log.inputTokens }}/{{ log.outputTokens }}</td>
              <td class="error-text" :title="log.error ?? undefined">{{ log.error ? log.error.slice(0, 50) : "-" }}</td>
            </tr>
            <tr v-if="expandedId === log.id && (log.inputContent || log.outputContent)" class="expand-row">
              <td colspan="9">
                <div class="expand-content">
                  <div v-if="log.inputContent" class="content-block">
                    <div class="content-label">提示词</div>
                    <pre class="content-text">{{ log.inputContent }}</pre>
                  </div>
                  <div v-if="log.outputContent" class="content-block">
                    <div class="content-label">模型响应</div>
                    <pre class="content-text">{{ log.outputContent }}</pre>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <div class="pagination">
        <button class="btn" :disabled="offset === 0" @click="prev">上一页</button>
        <span class="page-info">偏移: {{ offset }}</span>
        <button class="btn" :disabled="logs.length < limit" @click="next">下一页</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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

.content-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-dim);
  font-weight: 600;
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
</style>

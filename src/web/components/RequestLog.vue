<script setup lang="ts">
import { ref, onMounted } from "vue"
import { logApi, type LogEntry } from "../api"

const logs = ref<LogEntry[]>([])
const loading = ref(true)
const offset = ref(0)
const limit = 50

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
          <tr v-for="log in logs" :key="log.id">
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

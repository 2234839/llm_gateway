<script setup lang="ts">
import { ref, onMounted } from "vue"
import { healthApi, type HealthInfo } from "../api"

const info = ref<HealthInfo | null>(null)
const loading = ref(true)

onMounted(async () => {
  info.value = await healthApi.get()
  loading.value = false
})

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}小时 ${m}分`
}

async function refresh() {
  loading.value = true
  info.value = await healthApi.get()
  loading.value = false
}
</script>

<template>
  <div class="dashboard">
    <div class="toolbar">
      <h2>仪表盘</h2>
      <button class="btn" @click="refresh">刷新</button>
    </div>

    <div v-if="loading" class="loading">加载中...</div>

    <template v-else-if="info">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">状态</div>
          <div class="stat-value status-ok">{{ info.status }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">运行时间</div>
          <div class="stat-value">{{ formatUptime(info.uptime) }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">服务商</div>
          <div class="stat-value">{{ info.providers.enabled }} / {{ info.providers.total }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">路由规则</div>
          <div class="stat-value">{{ info.routeRules }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">总请求数</div>
          <div class="stat-value">{{ info.requests.total }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">今日请求</div>
          <div class="stat-value">{{ info.requests.today }}</div>
        </div>
      </div>

      <div class="detail-grid">
        <div class="detail-card">
          <h3>服务商请求统计</h3>
          <table class="table" v-if="info.requestsByProvider.length">
            <thead>
              <tr>
                <th>服务商</th>
                <th>总请求</th>
                <th>今日</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in info.requestsByProvider" :key="row.providerId">
                <td>{{ row.providerName }}</td>
                <td class="mono">{{ row.total }}</td>
                <td class="mono">{{ row.today }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="empty">暂无数据</div>
        </div>

        <div class="detail-card">
          <h3>模型请求统计</h3>
          <table class="table" v-if="info.requestsByModel.length">
            <thead>
              <tr>
                <th>请求模型</th>
                <th>映射模型</th>
                <th>总请求</th>
                <th>今日</th>
              </tr>
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
          <div v-else class="empty">暂无数据</div>
        </div>
      </div>
    </template>

    <div class="info-section">
      <h3>使用方式</h3>
      <pre class="code-block">export ANTHROPIC_BASE_URL=http://localhost:{{ info?.port }}
export ANTHROPIC_API_KEY=your-key</pre>
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
</style>

<script setup lang="ts">
import { ref, reactive, onMounted } from "vue"
import { skuUsageApi, curlQueryApi, type SkuUsageResponse, type BalanceResult, type CurlUsageResult } from "../api"
import { t } from "../i18n"

const skuUsageData = ref<SkuUsageResponse | null>(null)
const skuUsageLoading = ref(false)

/** 挂载时自动加载 */
onMounted(() => {
  loadSkuUsage()
})

/** cURL 导入/编辑表单状态 */
const showCurlForm = ref(false)
const editingCurlId = ref<string | null>(null)
const curlForm = reactive({
  name: "",
  curlString: "",
})
const curlTesting = ref(false)
const curlTestResult = ref<BalanceResult | CurlUsageResult | null>(null)
const curlSaving = ref(false)

async function loadSkuUsage() {
  skuUsageLoading.value = true
  try {
    skuUsageData.value = await skuUsageApi.get()
  } catch (e) {
    console.error("Failed to load sku usage:", e)
  }
  skuUsageLoading.value = false
}

function openCurlForm() {
  showCurlForm.value = true
  editingCurlId.value = null
  curlTestResult.value = null
  curlForm.name = ""
  curlForm.curlString = ""
}

function openEditCurl(query: { id: string; name: string }) {
  showCurlForm.value = true
  editingCurlId.value = query.id
  curlTestResult.value = null
  curlForm.name = query.name
  curlForm.curlString = ""
}

function closeCurlForm() {
  showCurlForm.value = false
  editingCurlId.value = null
  curlForm.name = ""
  curlForm.curlString = ""
  curlTestResult.value = null
}

async function deleteCurl(id: string) {
  if (!confirm(t('skuUsage.deleteConfirm'))) return
  try {
    await curlQueryApi.delete(id)
    await loadSkuUsage()
  } catch (e) {
    console.error("Failed to delete curl query:", e)
  }
}

async function testCurl() {
  if (!curlForm.curlString) return
  curlTesting.value = true
  curlTestResult.value = null
  try {
    curlTestResult.value = await curlQueryApi.test({
      curlString: curlForm.curlString,
    })
  } catch (e) {
    curlTestResult.value = { success: false, error: e instanceof Error ? e.message : "Test failed" }
  }
  curlTesting.value = false
}

async function saveCurl() {
  if (!curlForm.name || !curlForm.curlString) return
  curlSaving.value = true
  try {
    if (editingCurlId.value) {
      await curlQueryApi.update(editingCurlId.value, {
        name: curlForm.name,
      })
    } else {
      await curlQueryApi.create({
        name: curlForm.name,
        curlString: curlForm.curlString,
      })
    }
    closeCurlForm()
    await loadSkuUsage()
  } catch (e) {
    console.error("Failed to save curl query:", e)
  }
  curlSaving.value = false
}

function formatSkuTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatSkuMoney(n: number, currency?: string): string {
  const symbol = currency === "USD" ? "$" : "¥"
  return `${symbol}${n.toFixed(2)}`
}

function usageColor(percentage: number): string {
  if (percentage >= 90) return "var(--danger)"
  if (percentage >= 60) return "var(--warning)"
  return "var(--success)"
}

/**
 * 根据智谱 quota 的 unit + number 生成可读的时间周期标签
 * 实际观察: unit:5=5小时(固定周期), unit:3=小时, unit:6=周
 */
function formatZhipuPeriod(unit: number | undefined, number: number | undefined): string {
  if (unit == null || number == null) return ""
  if (unit === 5) return "5小时"
  if (unit === 3) return `${number}小时`
  if (unit === 6) return `${number}周`
  return `${number}[${unit}]`
}

/** 判断 cURL 查询结果是用量类型 */
function isUsageResult(result: BalanceResult | CurlUsageResult): result is CurlUsageResult {
  return "usages" in result
}

/** 计算百分比 */
function calcPercent(used: number, limit: number): number {
  if (limit <= 0) return 0
  return Math.min((used / limit) * 100, 100)
}
</script>

<template>
  <div>
    <div style="display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 8px;">
      <button
        class="btn-refresh"
        @click="openCurlForm"
      >
        {{ t('skuUsage.addCurl') }}
      </button>
      <button
        class="btn-refresh"
        :disabled="skuUsageLoading"
        @click="loadSkuUsage()"
      >
        {{ skuUsageLoading ? t('skuUsage.refreshing') : t('skuUsage.refresh') }}
      </button>
    </div>

    <div v-if="skuUsageLoading && !skuUsageData" class="loading">{{ t('skuUsage.loading') }}</div>
    <div v-else-if="!skuUsageData?.groups?.length && !skuUsageData?.curlQueries?.length" class="empty">{{ skuUsageLoading ? t('skuUsage.loading') : t('skuUsage.empty') }}</div>

    <div v-else class="sku-usage-grid">
      <div v-for="group in skuUsageData.groups" :key="group.provider" class="sku-usage-card">
        <div class="sku-card-header">
          <span class="sku-provider-name">{{ group.displayName }}</span>
          <span v-if="group.totalBalance != null" class="sku-total-balance">
            {{ formatSkuMoney(group.totalBalance, group.providers[0]?.currency) }}
          </span>
        </div>

        <div v-for="p in group.providers" :key="p.id" class="sku-provider-row">
          <div class="sku-row-name">{{ p.name }}</div>

          <div v-if="p.balance != null" class="sku-row-balance">
            {{ formatSkuMoney(p.balance, p.currency) }}
            <span v-if="p.grantedBalance != null || p.toppedUpBalance != null" class="sku-balance-detail">
              ({{ formatSkuMoney(p.toppedUpBalance ?? 0, p.currency) }} + {{ formatSkuMoney(p.grantedBalance ?? 0, p.currency) }})
            </span>
          </div>
          <div v-else-if="p.balanceError" class="sku-row-error">{{ p.balanceError }}</div>

          <div v-if="p.quota?.success && p.quota.limits" class="sku-quota-list">
            <div v-for="(limit, idx) in p.quota.limits" :key="idx" class="sku-quota-item">
              <div class="sku-quota-header">
                <span>
                  <template v-if="limit.type === 'TIME_LIMIT'">{{ t('skuUsage.toolLimit') }}</template>
                  <template v-else-if="limit.type === 'TOKENS_LIMIT'">{{ t('skuUsage.tokenLimit') }} ({{ formatZhipuPeriod(limit.unit, limit.number) }})</template>
                  <template v-else>{{ limit.type }}</template>
                </span>
                <span>{{ limit.percentage }}%</span>
              </div>
              <div class="sku-progress-bar">
                <div
                  class="sku-progress-fill"
                  :style="{ width: Math.min(limit.percentage, 100) + '%', background: usageColor(limit.percentage) }"
                />
              </div>
            </div>
          </div>
          <div v-else-if="p.quota && !p.quota.success" class="sku-row-error">{{ p.quota.error }}</div>

          <div class="sku-row-usage">
            <span>{{ t('skuUsage.weeklyTokens') }}: {{ formatSkuTokens(p.weeklyTokens) }}</span>
            <span>{{ t('skuUsage.monthlyTokens') }}: {{ formatSkuTokens(p.monthlyTokens) }}</span>
          </div>
        </div>
      </div>

      <!-- cURL 查询结果 -->
      <div v-if="skuUsageData.curlQueries?.length" class="sku-usage-card">
        <div class="sku-card-header">
          <span class="sku-provider-name">{{ t('skuUsage.curlQueries') }}</span>
        </div>
        <div v-for="q in skuUsageData.curlQueries" :key="q.id" class="sku-provider-row">
          <div class="sku-row-header">
            <span class="sku-row-name">{{ q.name }}</span>
            <div class="sku-row-actions">
              <button class="btn-icon" @click="openEditCurl(q)" title="Edit">&#9998;</button>
              <button class="btn-icon btn-delete" @click="deleteCurl(q.id)" title="Delete">&#10005;</button>
            </div>
          </div>
          <!-- 余额类型结果 -->
          <div v-if="q.result && 'balance' in q.result && q.result.success" class="sku-row-balance">
            {{ formatSkuMoney(q.result.balance ?? 0, q.result.currency) }}
          </div>
          <!-- 用量类型结果 (Kimi) -->
          <div v-else-if="q.result && isUsageResult(q.result) && q.result.success" class="sku-usage-list">
            <!-- 总配额 -->
            <div v-if="q.result.totalQuota" class="sku-total-quota">
              <span>{{ t('skuUsage.totalQuota') }}: {{ q.result.totalQuota.remaining }}/{{ q.result.totalQuota.limit }}</span>
            </div>
            <!-- 各 scope 用量 -->
            <div v-for="(usage, idx) in q.result.usages" :key="idx" class="sku-usage-detail">
              <div class="sku-usage-header">
                <span class="sku-usage-scope">{{ usage.scope }}</span>
                <span class="sku-usage-percent">{{ calcPercent(usage.used, usage.limit).toFixed(0) }}%</span>
              </div>
              <div class="sku-usage-numbers">
                <span>{{ t('skuUsage.limit') }}: {{ usage.limit }}</span>
                <span>{{ t('skuUsage.used') }}: {{ usage.used }}</span>
                <span>{{ t('skuUsage.remaining') }}: {{ usage.remaining }}</span>
              </div>
              <div class="sku-progress-bar">
                <div
                  class="sku-progress-fill"
                  :style="{ width: calcPercent(usage.used, usage.limit) + '%', background: usageColor(calcPercent(usage.used, usage.limit)) }"
                />
              </div>
              <!-- 子限额 (如 300 分钟窗口) -->
              <div v-if="usage.subLimits?.length" class="sku-sublimits">
                <div v-for="(sl, sidx) in usage.subLimits" :key="sidx" class="sku-sublimit">
                  <div class="sku-sublimit-header">
                    <span>{{ sl.window }}</span>
                    <span>{{ calcPercent(sl.used, sl.limit).toFixed(0) }}%</span>
                  </div>
                  <div class="sku-usage-numbers">
                    <span>{{ t('skuUsage.limit') }}: {{ sl.limit }}</span>
                    <span>{{ t('skuUsage.used') }}: {{ sl.used }}</span>
                    <span>{{ t('skuUsage.remaining') }}: {{ sl.remaining }}</span>
                  </div>
                  <div class="sku-progress-bar">
                    <div
                      class="sku-progress-fill"
                      :style="{ width: calcPercent(sl.used, sl.limit) + '%', background: usageColor(calcPercent(sl.used, sl.limit)) }"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="q.result && !q.result.success" class="sku-row-error">{{ q.result.error || t('skuUsage.queryFailed') }}</div>
        </div>
      </div>

      <!-- cURL 导入/编辑表单 -->
      <div v-else class="sku-usage-card sku-form-card">
        <div class="sku-form-header">
          <span>{{ editingCurlId ? t('skuUsage.editCurlTitle') : t('skuUsage.addCurlTitle') }}</span>
          <button class="btn-close" @click="closeCurlForm">&times;</button>
        </div>

        <div class="sku-form-body">
          <label class="sku-form-field">
            <span>{{ t('skuUsage.curlNameLabel') }}</span>
            <input v-model="curlForm.name" type="text" :placeholder="t('skuUsage.curlNamePlaceholder')" />
          </label>

          <label v-if="!editingCurlId" class="sku-form-field">
            <span>{{ t('skuUsage.curlCommandLabel') }}</span>
            <textarea
              v-model="curlForm.curlString"
              rows="6"
              :placeholder="t('skuUsage.curlCommandPlaceholder')"
            />
          </label>

          <!-- 提示信息 -->
          <div v-if="!editingCurlId" class="sku-form-hint">
            <p>{{ t('skuUsage.curlHint') }}</p>
            <code class="sku-form-code">https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages</code>
          </div>

          <div v-if="curlTestResult" class="sku-test-result">
            <div v-if="'balance' in curlTestResult && curlTestResult.success" class="sku-test-success">
              {{ t('skuUsage.testSuccess') }}: {{ formatSkuMoney(curlTestResult.balance ?? 0, curlTestResult.currency) }}
            </div>
            <div v-else-if="isUsageResult(curlTestResult) && curlTestResult.success && curlTestResult.usages" class="sku-test-success">
              {{ t('skuUsage.testSuccess') }}:
              <span v-for="(u, idx) in curlTestResult.usages" :key="idx">
                {{ u.scope }} {{ u.used }}/{{ u.limit }}
              </span>
            </div>
            <div v-else class="sku-test-fail">
              {{ t('skuUsage.testFail') }}: {{ curlTestResult.error }}
            </div>
          </div>

          <div class="sku-form-actions">
            <button v-if="!editingCurlId" class="btn-sm btn-primary" :disabled="curlTesting || !curlForm.curlString" @click="testCurl">
              {{ curlTesting ? t('skuUsage.testing') : t('skuUsage.test') }}
            </button>
            <button class="btn-sm btn-primary" :disabled="curlSaving || !curlForm.name || (!editingCurlId && !curlForm.curlString)" @click="saveCurl">
              {{ curlSaving ? t('skuUsage.saving') : t('skuUsage.save') }}
            </button>
            <button class="btn-sm" @click="closeCurlForm">{{ t('skuUsage.cancel') }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.card-header-row h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.btn-collapse {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}

.btn-collapse:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-refresh {
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-refresh:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading, .empty {
  text-align: center;
  padding: 1.5rem;
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.sku-usage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}

.sku-usage-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}

.sku-add-card {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
}

.btn-add-curl {
  padding: 0.5rem 1rem;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
}

.btn-add-curl:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.sku-form-card {
  grid-column: 1 / -1;
}

.sku-form-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.9rem;
}

.btn-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 1.25rem;
  cursor: pointer;
  line-height: 1;
}

.btn-close:hover {
  color: var(--text-primary);
}

.sku-form-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sku-form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sku-form-field span {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.sku-form-field input,
.sku-form-field textarea {
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 4px;
  font-size: 0.8rem;
  font-family: inherit;
  resize: vertical;
}

.sku-form-field input:focus,
.sku-form-field textarea:focus {
  outline: none;
  border-color: var(--primary);
}

.sku-form-hint {
  padding: 8px;
  background: var(--bg-primary);
  border-radius: 4px;
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.sku-form-hint p {
  margin: 0 0 4px 0;
}

.sku-form-code {
  display: block;
  padding: 4px 6px;
  background: var(--bg);
  border-radius: 3px;
  color: var(--text-primary);
  font-family: monospace;
  font-size: 0.7rem;
  word-break: break-all;
}

.sku-test-result {
  padding: 8px;
  border-radius: 4px;
  font-size: 0.8rem;
}

.sku-test-success {
  color: var(--success);
  background: var(--bg-primary);
}

.sku-test-fail {
  color: var(--danger);
  background: var(--bg-primary);
}

.sku-form-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.btn-sm {
  padding: 0.35rem 0.75rem;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.8rem;
}

.btn-sm:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.sku-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.sku-provider-name {
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.9rem;
}

.sku-total-balance {
  font-size: 0.875rem;
  color: var(--success);
  font-weight: 500;
}

.sku-provider-row {
  margin-bottom: 10px;
  padding: 8px;
  background: var(--bg-primary);
  border-radius: 6px;
}

.sku-row-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.sku-row-name {
  font-weight: 500;
  color: var(--text-primary);
  font-size: 0.875rem;
}

.sku-row-actions {
  display: flex;
  gap: 4px;
}

.btn-icon {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 2px 4px;
}

.btn-icon:hover {
  color: var(--text-primary);
}

.btn-delete:hover {
  color: var(--danger);
}

.sku-row-balance {
  font-size: 0.875rem;
  color: var(--success);
  font-weight: 500;
}

.sku-balance-detail {
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-left: 4px;
}

.sku-row-error {
  font-size: 0.8rem;
  color: var(--danger);
}

.sku-quota-list {
  margin: 6px 0;
}

.sku-quota-item {
  margin-bottom: 6px;
}

.sku-quota-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  margin-bottom: 2px;
  color: var(--text-secondary);
}

.sku-progress-bar {
  height: 4px;
  background: var(--bg-hover);
  border-radius: 2px;
  overflow: hidden;
}

.sku-progress-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.sku-row-usage {
  display: flex;
  gap: 12px;
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-top: 4px;
}

.sku-usage-list {
  margin: 6px 0;
}

.sku-total-quota {
  font-size: 0.8rem;
  color: var(--text-primary);
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.sku-usage-detail {
  margin-bottom: 10px;
}

.sku-usage-detail:last-child {
  margin-bottom: 0;
}

.sku-usage-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2px;
}

.sku-usage-scope {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-primary);
}

.sku-usage-percent {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.sku-usage-numbers {
  display: flex;
  gap: 10px;
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.sku-sublimits {
  margin-top: 8px;
  padding-left: 12px;
  border-left: 2px solid var(--border);
}

.sku-sublimit {
  margin-bottom: 8px;
}

.sku-sublimit:last-child {
  margin-bottom: 0;
}

.sku-sublimit-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-bottom: 2px;
}

@media (max-width: 640px) {
  .sku-usage-grid {
    grid-template-columns: 1fr;
  }
}
</style>

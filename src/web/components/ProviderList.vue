<script setup lang="ts">
import { ref, computed, onMounted } from "vue"
import { providerApi, type ProviderInfo, type ProviderTestResult } from "../api"
import { t } from "../i18n"

const error = ref("")

const providers = ref<ProviderInfo[]>([])
const loading = ref(true)
const editing = ref<ProviderInfo | null>(null)
const creating = ref(false)

const emptyProvider: Omit<ProviderInfo, "id"> = {
  name: "",
  type: "openai",
  baseUrl: "",
  apiKey: "",
  models: [],
  enabled: true,
  maxConcurrency: 0,
  requestTimeout: 0,
  customHeaders: {},
}

const form = ref({ ...emptyProvider })

/** 测试连通性状态 */
const testing = ref(false)
const testResult = ref<ProviderTestResult | null>(null)

/** 批量健康检查结果：providerId -> TestResult */
const healthMap = ref<Map<string, ProviderTestResult & { checking?: boolean }>>(new Map())

/** 安全获取 provider 健康检查状态 */
function getHealth(id: string) {
  return healthMap.value.get(id)
}

/** 模型输入框临时值 */
const modelInput = ref("")

onMounted(async () => {
  await load()
  checkAllHealth()
})

async function load() {
  loading.value = true
  error.value = ""
  try {
    providers.value = await providerApi.list()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Failed to load"
  }
  loading.value = false
}

/** 并行检查所有启用 provider 的连通性（最多 5 个并发） */
async function checkAllHealth() {
  const enabled = providers.value.filter(p => p.enabled)
  /** 清理已不存在的 provider 的健康检查结果 */
  const activeIds = new Set(enabled.map(p => p.id))
  for (const id of healthMap.value.keys()) {
    if (!activeIds.has(id)) healthMap.value.delete(id)
  }
  const CONCURRENCY = 5
  let idx = 0
  async function runNext(): Promise<void> {
    if (idx >= enabled.length) return
    const p = enabled[idx++]
    healthMap.value.set(p.id, { success: false, statusCode: 0, duration: 0, checking: true })
    try {
      const result = await providerApi.testById(p.id)
      healthMap.value.set(p.id, { ...result, checking: false })
    } catch {
      healthMap.value.set(p.id, { success: false, statusCode: 0, duration: 0, checking: false })
    }
    await runNext()
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, enabled.length) }, () => runNext())
  await Promise.allSettled(workers)
}

function startEdit(p: ProviderInfo) {
  editing.value = p
  /** apiKey 已脱敏，编辑时清空并用 placeholder 提示 */
  form.value = { ...p, apiKey: "", customHeaders: { ...(p.customHeaders ?? {}) } }
  creating.value = false
  testResult.value = null
  modelInput.value = ""
  syncHeadersFromForm()
}

function startCreate() {
  editing.value = null
  creating.value = true
  form.value = { ...emptyProvider, customHeaders: {} }
  testResult.value = null
  modelInput.value = ""
  headerEntries.value = []
}

function cancel() {
  editing.value = null
  creating.value = false
  testResult.value = null
  modelInput.value = ""
}

async function save() {
  error.value = ""
  if (!form.value.name.trim()) { error.value = t('provider.errorNameRequired'); return }
  if (!form.value.baseUrl.trim()) { error.value = t('provider.errorUrlRequired'); return }
  /** 创建时 apiKey 必填，编辑时为空表示不修改 */
  if (creating.value && !form.value.apiKey.trim()) { error.value = t('provider.errorKeyRequired'); return }
  if (form.value.models.length === 0) { error.value = t('provider.errorModelRequired'); return }
  /** 防止 v-model.number 清空后产生 NaN */
  if (Number.isNaN(form.value.maxConcurrency)) form.value.maxConcurrency = 0
  if (Number.isNaN(form.value.requestTimeout)) form.value.requestTimeout = 0
  try {
    if (creating.value) {
      await providerApi.create(form.value)
    } else if (editing.value) {
      /** 编辑时只发送非空字段 */
      const data: Partial<typeof form.value> = { ...form.value }
      if (!data.apiKey?.trim()) delete data.apiKey
      await providerApi.update(editing.value.id, data)
    }
    cancel()
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Save failed"
  }
}

async function remove(id: string) {
  const provider = providers.value.find(p => p.id === id)
  if (!confirm(t('provider.deleteConfirm', { name: provider?.name ?? '' }))) return
  error.value = ""
  try {
    await providerApi.delete(id)
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : t('provider.deleteFailed')
  }
}

async function toggleEnabled(p: ProviderInfo) {
  error.value = ""
  try {
    await providerApi.update(p.id, { enabled: !p.enabled })
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Update failed"
  }
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  error.value = ""
  /** 使用第一个配置的模型作为测试模型（Anthropic 类型会用到） */
  const testModel = form.value.models[0] || undefined
  const data = { baseUrl: form.value.baseUrl, apiKey: form.value.apiKey, type: form.value.type, model: testModel, customHeaders: form.value.customHeaders }
  try {
    testResult.value = await providerApi.test(data)
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Test failed"
  }
  testing.value = false
}

function addModel() {
  const val = modelInput.value.trim()
  if (!val) return
  if (form.value.models.includes(val)) {
    modelInput.value = ""
    return
  }
  form.value.models = [...form.value.models, val]
  modelInput.value = ""
}

function removeModel(index: number) {
  form.value.models = form.value.models.filter((_, i) => i !== index)
}

const typeOptions = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "azure-openai", label: "Azure OpenAI" },
  { value: "custom", label: "Custom (OpenAI-compatible)" },
]

const urlPlaceholders: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  "azure-openai": "https://YOUR_RESOURCE.openai.azure.com",
  custom: "https://your-provider.example.com/v1",
}

const urlPlaceholder = computed(() => urlPlaceholders[form.value.type] ?? urlPlaceholders.custom)

/** 自定义 Headers 编辑 */
const headerEntries = ref<{ key: string; value: string }[]>([])

function syncHeadersFromForm() {
  const h = form.value.customHeaders ?? {}
  headerEntries.value = Object.entries(h).map(([key, value]) => ({ key, value }))
}

function syncHeadersToForm() {
  const h: Record<string, string> = {}
  for (const e of headerEntries.value) {
    if (e.key.trim()) h[e.key.trim()] = e.value.trim()
  }
  form.value.customHeaders = h
}

function addHeader() {
  headerEntries.value.push({ key: "", value: "" })
}

function removeHeader(index: number) {
  headerEntries.value.splice(index, 1)
  syncHeadersToForm()
}
</script>

<template>
  <div class="provider-list">
    <div class="toolbar">
      <h2>{{ t('provider.title') }}</h2>
      <button class="btn btn-primary" @click="startCreate">{{ t('provider.addProvider') }}</button>
    </div>

    <div v-if="loading" class="loading">{{ t('provider.loading') }}</div>

    <p v-if="error" class="error-text">{{ error }}</p>

    <div v-else>
      <table class="table" v-if="!creating && !editing">
        <thead>
          <tr>
            <th>{{ t('provider.nameCol') }}</th>
            <th>{{ t('provider.typeCol') }}</th>
            <th>{{ t('provider.urlCol') }}</th>
            <th>{{ t('provider.modelCol') }}</th>
            <th>{{ t('provider.concurrencyCol') }}</th>
            <th>{{ t('provider.actionsCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in providers" :key="p.id">
            <td>
              <span v-if="p.enabled && getHealth(p.id)" :class="['health-dot', getHealth(p.id)!.checking ? 'checking' : getHealth(p.id)!.success ? 'ok' : 'err']" :title="getHealth(p.id)!.checking ? t('provider.healthChecking') : getHealth(p.id)!.success ? `${t('provider.healthOk')} (${getHealth(p.id)!.duration}ms)` : `${t('provider.healthFail')} ${getHealth(p.id)!.statusCode}`"></span>
              <span v-else-if="!p.enabled" class="health-dot disabled"></span>
              {{ p.name }}
            </td>
            <td><span class="badge">{{ p.type }}</span></td>
            <td class="mono">{{ p.baseUrl }}</td>
            <td>
              <span v-for="m in p.models.slice(0, 3)" :key="m" class="model-tag">{{ m }}</span>
              <span v-if="p.models.length > 3" class="model-tag model-more" :title="p.models.slice(3).join(', ')">+{{ p.models.length - 3 }}</span>
            </td>
            <td>{{ p.maxConcurrency || t('provider.unlimited') }}</td>
            <td colspan="2">
              <div class="actions-cell">
                <label class="toggle" :title="p.enabled ? t('provider.enabled') : t('provider.disabled')">
                  <input type="checkbox" :checked="p.enabled" @change="toggleEnabled(p)" />
                  <span class="toggle-slider"></span>
                </label>
                <button class="btn-sm" @click="startEdit(p)">{{ t('provider.edit') }}</button>
                <button class="btn-sm btn-danger" @click="remove(p.id)">{{ t('provider.delete') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="providers.length === 0 && !creating && !editing" class="empty">{{ t('provider.noProviders') }}</div>

      <div v-if="creating || editing" class="form-card">
        <h3>{{ creating ? t('provider.addTitle') : t('provider.editTitle') }}</h3>
        <div class="form-grid">
          <label>
            {{ t('provider.nameLabel') }}
            <input v-model="form.name" :placeholder="t('provider.namePlaceholder')" />
          </label>
          <label>
            {{ t('provider.typeLabel') }}
            <select v-model="form.type">
              <option v-for="opt in typeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </label>
          <label class="span-2">
            {{ t('provider.urlLabel') }}
            <input v-model="form.baseUrl" :placeholder="urlPlaceholder" class="mono" />
          </label>
          <label class="span-2">
            {{ t('provider.apiKeyLabel') }}
            <input v-model="form.apiKey" type="password" :placeholder="editing ? t('provider.apiKeyEditHint') : t('provider.apiKeyPlaceholder')" />
          </label>
          <label class="span-2">
            {{ t('provider.modelLabel') }}
            <div class="model-input-row">
              <div class="model-tags">
                <span v-for="(m, i) in form.models" :key="i" class="model-tag removable" @click="removeModel(i)">
                  {{ m }}
                  <span class="remove-x">&times;</span>
                </span>
              </div>
              <div class="model-add-row">
                <input
                  v-model="modelInput"
                  :placeholder="t('provider.modelInputPlaceholder')"
                  @keydown.enter.prevent="addModel"
                />
                <button class="btn-sm" type="button" @click="addModel">+</button>
              </div>
            </div>
          </label>
          <label>
            {{ t('provider.concurrencyLabel') }}
            <input v-model.number="form.maxConcurrency" type="number" min="0" :placeholder="t('provider.concurrencyPlaceholder')" />
          </label>
          <label>
            {{ t('provider.timeoutLabel') }}
            <input v-model.number="form.requestTimeout" type="number" min="0" :placeholder="t('provider.timeoutPlaceholder')" />
          </label>
          <label>
            {{ t('provider.enabledLabel') }}
            <input type="checkbox" v-model="form.enabled" />
          </label>
        </div>

        <!-- 自定义 Headers -->
        <div class="headers-section">
          <div class="section-label">{{ t('provider.customHeadersLabel') }}</div>
          <p class="section-hint">{{ t('provider.customHeadersHint') }}</p>
          <div v-for="(entry, i) in headerEntries" :key="i" class="header-row">
            <input v-model="entry.key" :placeholder="t('provider.headerKeyPlaceholder')" class="header-key" @input="syncHeadersToForm" />
            <input v-model="entry.value" :placeholder="t('provider.headerValuePlaceholder')" class="header-value" @input="syncHeadersToForm" />
            <button class="btn-sm btn-danger" type="button" @click="removeHeader(i)">&times;</button>
          </div>
          <button class="btn-sm" type="button" @click="addHeader">{{ t('provider.addHeader') }}</button>
        </div>

        <div v-if="testResult" :class="['test-result', { success: testResult.success, fail: !testResult.success }]">
          {{ testResult.success
            ? t('provider.testSuccess', { code: testResult.statusCode, ms: testResult.duration })
            : t('provider.testFail', { code: testResult.statusCode, error: testResult.error ?? t('provider.unknownError') }) }}
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" @click="save">{{ t('provider.save') }}</button>
          <button class="btn" :disabled="testing" @click="testConnection">
            {{ testing ? t('provider.testing') : t('provider.testConnection') }}
          </button>
          <button class="btn" @click="cancel">{{ t('provider.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.actions-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}


.model-input-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.model-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.model-tag.removable {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.remove-x {
  font-size: 14px;
  opacity: 0.6;
}

.remove-x:hover {
  opacity: 1;
}

.model-add-row {
  display: flex;
  gap: 4px;
}

.model-add-row input {
  flex: 1;
}

.test-result {
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 14px;
  margin-bottom: 12px;
}

.test-result.success {
  background: var(--test-ok-bg);
  color: var(--test-ok);
  border: 1px solid var(--test-ok-border);
}

.test-result.fail {
  background: var(--test-fail-bg);
  color: var(--test-fail);
  border: 1px solid var(--test-fail-border);
}

.health-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}

.health-dot.ok { background: var(--ok); }
.health-dot.err { background: var(--err); }
.health-dot.checking { background: var(--text-dim); animation: pulse 1s infinite; }
.health-dot.disabled { background: var(--border); }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.headers-section {
  margin-top: 12px;
}

.section-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-dim);
  margin-bottom: 6px;
}

.section-hint {
  font-size: 12px;
  color: var(--text-dim);
  margin: 0 0 8px;
}

.header-row {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}

.header-key {
  width: 200px;
  font-family: var(--mono);
}

.header-value {
  flex: 1;
}

.error-text {
  color: var(--err);
  font-size: 13px;
  margin-bottom: 12px;
}

.empty {
  text-align: center;
  padding: 40px 0;
  color: var(--text-dim);
  font-size: 13px;
}
</style>

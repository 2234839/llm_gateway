<script setup lang="ts">
import { ref, computed, onMounted } from "vue"
import { providerApi, type ProviderInfo, type ProviderTestResult, type ModelDiscoveryResult } from "../api"
import { t } from "../i18n"
import { randomColor } from "../utils/color"

const error = ref("")

const providers = ref<ProviderInfo[]>([])
const loading = ref(true)
const editing = ref<ProviderInfo | null>(null)
const creating = ref(false)
const saving = ref(false)

const emptyProvider: Omit<ProviderInfo, "id"> = {
  name: "",
  type: "openai",
  baseUrl: "",
  apiKey: "",
  models: [],
  enabled: true,
  protocolEndpoints: {},
  maxConcurrency: 0,
  requestTimeout: 0,
  color: "",
  customHeaders: {},
  allowedClientHeaders: [],
  flattenMidSystem: false,
}

const form = ref({ ...emptyProvider })

/** 控制 apiKey 输入框的显示/隐藏 */
const showApiKey = ref(false)

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

/** 模型侦查状态 */
const scouting = ref(false)
const scoutResult = ref<ModelDiscoveryResult | null>(null)
/** 侦查结果过滤关键字 */
const scoutFilter = ref("")

/** 过滤后的侦查结果（未添加的排前面，已添加的沉底） */
const filteredScoutModels = computed(() => {
  const models = scoutResult.value?.models ?? []
  const kw = scoutFilter.value.trim().toLowerCase()
  const matched = kw ? models.filter(m => m.toLowerCase().includes(kw)) : models
  const pending = matched.filter(m => !form.value.models.includes(m))
  const added = matched.filter(m => form.value.models.includes(m))
  return [...pending, ...added]
})

/** 侦查结果中尚未加入模型列表的数量 */
const scoutNewCount = computed(() => (scoutResult.value?.models ?? []).filter(m => !form.value.models.includes(m)).length)

/** 侦查上游模型列表：编辑已有 provider 时使用后端存储的 key，新建时使用表单中的 key */
async function scoutModels() {
  scouting.value = true
  scoutResult.value = null
  scoutFilter.value = ""
  error.value = ""
  try {
    if (editing.value && !form.value.apiKey.trim()) {
      /** 编辑且未改 key：走后端存储的 key */
      scoutResult.value = await providerApi.discoverModelsById(editing.value.id)
    } else {
      scoutResult.value = await providerApi.discoverModels({
        baseUrl: form.value.baseUrl,
        apiKey: form.value.apiKey,
        type: form.value.type,
        customHeaders: form.value.customHeaders,
      })
    }
  } catch (e: unknown) {
    /** HTTP 层错误（如 429 限流）也展示在侦查面板内，不污染全局 error 避免影响整个表单 */
    scoutResult.value = { success: false, error: e instanceof Error ? e.message : "Scout failed" }
  }
  scouting.value = false
}

/** 从侦查结果添加单个模型 */
function addScoutedModel(m: string) {
  if (form.value.models.includes(m)) return
  form.value.models = [...form.value.models, m]
}

/** 一键添加侦查结果中所有未添加的模型 */
function addAllScoutedModels() {
  const pending = (scoutResult.value?.models ?? []).filter(m => !form.value.models.includes(m))
  if (pending.length === 0) return
  form.value.models = [...form.value.models, ...pending]
}

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
  form.value = { ...p, customHeaders: { ...(p.customHeaders ?? {}) }, allowedClientHeaders: [...(p.allowedClientHeaders ?? [])], protocolEndpoints: { ...(p.protocolEndpoints ?? {}) } }
  creating.value = false
  testResult.value = null
  modelInput.value = ""
  scoutResult.value = null
  scoutFilter.value = ""
  syncHeadersFromForm()
  resetProtocolRows()
}

function startCreate() {
  editing.value = null
  creating.value = true
  form.value = { ...emptyProvider, customHeaders: {}, allowedClientHeaders: [], protocolEndpoints: {} }
  testResult.value = null
  modelInput.value = ""
  scoutResult.value = null
  scoutFilter.value = ""
  headerEntries.value = []
  resetProtocolRows()
}

function cancel() {
  editing.value = null
  creating.value = false
  testResult.value = null
  modelInput.value = ""
  scoutResult.value = null
  scoutFilter.value = ""
}

async function save() {
  error.value = ""
  if (!form.value.name.trim()) { error.value = t('provider.errorNameRequired'); return }
  /** 先把协议行状态同步到 form（URL 可能在行输入框中修改） */
  syncRowsToForm()
  if (!form.value.baseUrl.trim()) { error.value = t('provider.errorUrlRequired'); return }
  /** 检查所有已启用的额外协议端点 URL 均已填写 */
  for (const [proto, url] of Object.entries(form.value.protocolEndpoints ?? {})) {
    if (url !== undefined && !url.trim()) {
      error.value = t('provider.errorProtocolUrlRequired', { proto })
      return
    }
  }
  /** 创建时 apiKey 必填，编辑时为空表示不修改 */
  if (creating.value && !form.value.apiKey.trim()) { error.value = t('provider.errorKeyRequired'); return }
  if (form.value.models.length === 0) { error.value = t('provider.errorModelRequired'); return }
  /** 防止 v-model.number 清空后产生 NaN */
  if (Number.isNaN(form.value.maxConcurrency)) form.value.maxConcurrency = 0
  if (Number.isNaN(form.value.requestTimeout)) form.value.requestTimeout = 0
  saving.value = true
  try {
    if (creating.value) {
      await providerApi.create(form.value)
    } else if (editing.value) {
      /** 编辑时只发送非空字段；apiKey 空 = 不修改 */
      const data: Partial<typeof form.value> = { ...form.value }
      if (!data.apiKey?.trim()) delete data.apiKey
      /** 清空颜色时发 null 表达清除意图（JSON 会丢弃 undefined，空串会污染 DB；null 由后端归一为 undefined） */
      const payload = (data.color === "" ? { ...data, color: null } : data) as Parameters<typeof providerApi.update>[1]
      await providerApi.update(editing.value.id, payload)
    }
    cancel()
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Save failed"
  }
  saving.value = false
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
  { value: "openai-responses", label: "OpenAI Responses" },
]

const urlPlaceholders: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  "azure-openai": "https://YOUR_RESOURCE.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT",
  custom: "https://your-provider.example.com/v1",
  "openai-responses": "https://api.deepseek.com",
}

/**
 * 协议行模型：每个协议一行（勾选 + URL + 主端点单选）
 * 主端点协议 = form.type，主端点 URL = form.baseUrl
 */
interface ProtocolRow {
  value: string
  label: string
  enabled: boolean
  url: string
  primary: boolean
}

/** 从 form 状态构建协议行列表（保持 typeOptions 固定顺序） */
function buildProtocolRows(): ProtocolRow[] {
  const eps = form.value.protocolEndpoints ?? {}
  return typeOptions.map(o => ({
    value: o.value,
    label: o.label,
    enabled: form.value.type === o.value || eps[o.value as keyof typeof eps] !== undefined,
    url: form.value.type === o.value ? form.value.baseUrl : (eps[o.value as keyof typeof eps] ?? ""),
    primary: form.value.type === o.value,
  }))
}

/** 协议行（响应式，供模板渲染） */
const protocolRows = ref<ProtocolRow[]>(buildProtocolRows())

/** 重建协议行（编辑/新建/取消时调用） */
function resetProtocolRows() {
  protocolRows.value = buildProtocolRows()
}

/** 行勾选状态变化：勾选时初始化 URL，取消时清空 */
function onRowToggle(row: ProtocolRow, enabled: boolean) {
  row.enabled = enabled
  if (!enabled && row.primary) {
    /** 主端点不可取消——至少保留一个协议 */
    row.enabled = true
    return
  }
  if (!enabled) row.url = ""
  syncRowsToForm()
}

/** 切换主端点协议（radio） */
function onPrimaryChange(row: ProtocolRow) {
  for (const r of protocolRows.value) {
    r.primary = r.value === row.value
    /** 新主端点必须是启用的 */
    if (r.primary) r.enabled = true
  }
  syncRowsToForm()
}

/** 协议行状态 → form.type / form.baseUrl / form.protocolEndpoints */
function syncRowsToForm() {
  const primaryRow = protocolRows.value.find(r => r.primary) ?? protocolRows.value[0]!
  form.value.type = primaryRow.value as typeof form.value.type
  form.value.baseUrl = primaryRow.url
  const eps: NonNullable<typeof form.value.protocolEndpoints> = {}
  for (const r of protocolRows.value) {
    if (r.enabled && !r.primary && r.url.trim()) {
      eps[r.value as keyof typeof eps] = r.url
    }
  }
  form.value.protocolEndpoints = eps
}

/** 自定义 Headers 编辑 */
const headerEntries = ref<{ key: string; value: string }[]>([])

/** allowedClientHeaders 单行输入（逗号分隔） */
const allowedClientHeadersInput = computed({
  get: () => (form.value.allowedClientHeaders ?? []).join(", "),
  set: (v: string) => {
    form.value.allowedClientHeaders = v.split(",").map(s => s.trim()).filter(Boolean)
  },
})

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

    <div v-if="!loading">
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
            <td>
              <span class="badge">{{ p.type }}</span>
              <span v-for="proto in Object.keys(p.protocolEndpoints ?? {})" :key="proto" class="badge badge-extra" :title="`${p.protocolEndpoints![proto as keyof NonNullable<typeof p.protocolEndpoints>]}`">+{{ proto }}</span>
            </td>
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
          <!-- 协议端点配置：每协议一行（勾选 + URL + 主端点单选），主端点协议即服务商类型 -->
          <div class="span-2 protocol-endpoints">
            <div class="section-label">{{ t('provider.protocolEndpointsLabel') }}</div>
            <p class="section-hint">{{ t('provider.protocolEndpointsHint') }}</p>
            <div class="protocol-table">
              <div v-for="row in protocolRows" :key="row.value" class="protocol-row">
                <label class="protocol-check">
                  <input
                    type="checkbox"
                    :checked="row.enabled"
                    :disabled="row.primary"
                    @change="onRowToggle(row, ($event.target as HTMLInputElement).checked)"
                  />
                </label>
                <span class="protocol-name">{{ row.label }}</span>
                <input
                  v-model="row.url"
                  :placeholder="urlPlaceholders[row.value] ?? urlPlaceholders.custom"
                  class="mono protocol-url"
                  :disabled="!row.enabled"
                  @input="syncRowsToForm"
                />
                <label class="protocol-primary" :title="t('provider.primaryEndpointHint')">
                  <input
                    type="radio"
                    name="primary-protocol"
                    :checked="row.primary"
                    :disabled="!row.enabled"
                    @change="onPrimaryChange(row)"
                  />
                  {{ t('provider.primaryEndpoint') }}
                </label>
              </div>
            </div>
          </div>
          <label class="span-2">
            {{ t('provider.apiKeyLabel') }}
            <div class="apikey-input-row">
              <input v-model="form.apiKey" :type="showApiKey ? 'text' : 'password'" :placeholder="editing ? t('provider.apiKeyEditHint') : t('provider.apiKeyPlaceholder')" />
              <button type="button" class="btn-icon" @click="showApiKey = !showApiKey">
                {{ showApiKey ? '🙈' : '👁️' }}
              </button>
            </div>
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
                <button class="btn-sm scout-btn" type="button" :disabled="scouting" @click="scoutModels">
                  {{ scouting ? t('provider.scouting') : t('provider.scout') }}
                </button>
              </div>
              <!-- 侦查结果：只读展示，不自动填充，手动逐个/全部添加 -->
              <div v-if="scoutResult" class="scout-panel">
                <template v-if="scoutResult.success">
                  <div class="scout-toolbar">
                    <input v-model="scoutFilter" class="scout-filter" :placeholder="t('provider.scoutFilterPlaceholder')" />
                    <button
                      v-if="scoutNewCount > 0"
                      class="btn-sm"
                      type="button"
                      @click="addAllScoutedModels"
                    >{{ t('provider.scoutAddAll', { count: scoutNewCount }) }}</button>
                  </div>
                  <div class="scout-list">
                    <span
                      v-for="m in filteredScoutModels"
                      :key="m"
                      :class="['model-tag', 'scout-tag', { added: form.models.includes(m) }]"
                      @click="addScoutedModel(m)"
                    >{{ m }}</span>
                    <span v-if="filteredScoutModels.length === 0" class="scout-empty">{{ t('provider.scoutNoMatch') }}</span>
                  </div>
                </template>
                <div v-else class="scout-error">
                  {{ t('provider.scoutFail', { error: scoutResult.error ?? t('provider.unknownError') }) }}
                  <span v-if="scoutResult.endpoint" class="scout-endpoint mono">{{ scoutResult.endpoint }}</span>
                </div>
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
            {{ t('provider.colorLabel') }}
            <div class="color-input-row">
              <input type="color" :value="form.color || '#6366f1'" @input="form.color = ($event.target as HTMLInputElement).value" />
              <input type="text" v-model="form.color" :placeholder="t('provider.colorPlaceholder')" class="color-text-input" />
              <button type="button" class="btn-sm" @click="form.color = randomColor()">{{ t('provider.randomColor') }}</button>
              <button type="button" class="btn-sm" v-if="form.color" @click="form.color = ''">✕</button>
            </div>
          </label>
          <label>
            {{ t('provider.enabledLabel') }}
            <input type="checkbox" v-model="form.enabled" />
          </label>
          <label>
            {{ t('provider.flattenMidSystemLabel') }}
            <input type="checkbox" v-model="form.flattenMidSystem" />
            <small class="field-hint">{{ t('provider.flattenMidSystemHint') }}</small>
          </label>
        </div>

        <!-- 自定义 Headers -->
        <div class="headers-section">
          <div class="section-label">{{ t('provider.customHeadersLabel') }}</div>
          <p class="section-hint">{{ t('provider.customHeadersHint') }}</p>
          <div class="section-label">{{ t('provider.allowedClientHeadersLabel') }}</div>
          <p class="section-hint">{{ t('provider.allowedClientHeadersHint') }}</p>
          <input v-model="allowedClientHeadersInput" class="mono" :placeholder="t('provider.allowedClientHeadersPlaceholder')" />
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
          <button class="btn btn-primary" @click="save" :disabled="saving">{{ saving ? '...' : t('provider.save') }}</button>
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

.scout-btn {
  white-space: nowrap;
}

.scout-panel {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.scout-toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
}

.scout-filter {
  flex: 1;
  font-size: 13px;
}

.scout-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.scout-tag {
  cursor: pointer;
}

.scout-tag.added {
  opacity: 0.45;
  cursor: default;
  text-decoration: line-through;
}

.scout-empty {
  color: var(--text-dim);
  font-size: 13px;
}

.scout-error {
  color: var(--err);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.scout-endpoint {
  font-size: 12px;
  color: var(--text-dim);
  word-break: break-all;
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

.protocol-endpoints {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/** 列表中额外协议的角标（+anthropic 等），比主类型徽标弱化显示 */
.badge-extra {
  margin-left: 4px;
  opacity: 0.75;
}

/** 协议行表格：每行 = 勾选 + 协议名 + URL + 主端点单选 */
.protocol-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.protocol-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.protocol-check {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}

.protocol-name {
  flex-shrink: 0;
  width: 190px;
  font-size: 13px;
  color: var(--text-dim);
}

.protocol-url {
  flex: 1;
}

.protocol-url:disabled {
  opacity: 0.45;
}

.protocol-primary {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
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

.apikey-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.apikey-input-row input {
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

@media (max-width: 768px) {
  .table {
    display: block;
    overflow-x: auto;
    min-width: 500px;
  }
  .model-add-row {
    flex-wrap: wrap;
  }
  .header-row {
    flex-wrap: wrap;
  }
  .header-key {
    width: 100%;
  }
}

.color-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.color-input-row input[type="color"] {
  width: 36px;
  height: 36px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  cursor: pointer;
}

.color-text-input {
  width: 100px;
}
</style>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue"
import { routeApi, providerApi, keyGroupApi, type RouteRuleInfo, type RouteFallback, type ProviderInfo, type KeyGroupInfo } from "../api"
import { t } from "../i18n"

const rules = ref<RouteRuleInfo[]>([])
const providers = ref<ProviderInfo[]>([])
const keyGroups = ref<KeyGroupInfo[]>([])
const loading = ref(true)
const creating = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const error = ref("")

const emptyRule: Omit<RouteRuleInfo, "id"> = {
  pattern: "",
  providerId: "",
  targetModel: "",
  modelMapping: {},
  priority: 0,
  contentMatch: [],
  excludeMatch: [],
  fallbacks: [],
  fallbackOnClientError: false,
  keyGroups: [],
}

const form = ref({ ...emptyRule })

/** 选中的服务商下可用的模型列表 */
const providerModels = computed(() => {
  if (!form.value.providerId) return []
  return providers.value.find(p => p.id === form.value.providerId)?.models ?? []
})

onMounted(load)

async function load() {
  loading.value = true
  error.value = ""
  try {
    const [r, p, g] = await Promise.all([routeApi.list(), providerApi.list(), keyGroupApi.list()])
    rules.value = r
    providers.value = p
    keyGroups.value = g
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Failed to load"
  }
  loading.value = false
}

function startCreate() {
  editingId.value = null
  creating.value = true
  form.value = { ...emptyRule, contentMatch: [], excludeMatch: [], keyGroups: [], fallbacks: [], fallbackOnClientError: false, modelMapping: {} }
  syncMappingFromForm()
}

function startEdit(rule: RouteRuleInfo) {
  editingId.value = rule.id
  creating.value = true
  form.value = {
    pattern: rule.pattern,
    providerId: rule.providerId,
    targetModel: rule.targetModel ?? "",
    modelMapping: rule.modelMapping ? { ...rule.modelMapping } : {},
    priority: rule.priority,
    contentMatch: rule.contentMatch ? rule.contentMatch.map(c => ({ ...c })) : [],
    excludeMatch: rule.excludeMatch ? rule.excludeMatch.map(c => ({ ...c })) : [],
    fallbacks: rule.fallbacks ? rule.fallbacks.map(f => ({ ...f })) : [],
    fallbackOnClientError: rule.fallbackOnClientError ?? false,
    keyGroups: rule.keyGroups ? [...rule.keyGroups] : [],
  }
  syncMappingFromForm()
}

function cancel() {
  editingId.value = null
  creating.value = false
}

async function save() {
  /** 保存前将 mapping 条目同步到 form */
  syncMappingToForm()
  const data = { ...form.value }
  if (!data.providerId) { error.value = t('route.errorProviderRequired'); return }
  if (!data.contentMatch?.length) data.contentMatch = undefined
  if (!data.excludeMatch?.length) data.excludeMatch = undefined
  if (!data.targetModel) data.targetModel = undefined
  if (!data.pattern) data.pattern = ""
  if (!data.fallbacks?.length) data.fallbacks = undefined
  /** 验证 fallback 的 providerId */
  if (data.fallbacks) {
    for (const fb of data.fallbacks) {
      if (!fb.providerId) { error.value = t('route.errorFallbackProviderRequired'); return }
    }
  }
  if (!data.keyGroups?.length) data.keyGroups = undefined
  if (!data.modelMapping || !Object.keys(data.modelMapping).length) data.modelMapping = undefined
  error.value = ""
  saving.value = true
  try {
    if (editingId.value) {
      await routeApi.update(editingId.value, data)
    } else {
      await routeApi.create(data)
    }
    cancel()
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Save failed"
  }
  saving.value = false
}

async function remove(id: string) {
  const rule = rules.value.find(r => r.id === id)
  if (!confirm(t('route.deleteConfirm', { pattern: rule?.pattern ?? '' }))) return
  error.value = ""
  try {
    await routeApi.delete(id)
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Delete failed"
  }
}

async function toggleEnabled(rule: RouteRuleInfo) {
  error.value = ""
  try {
    await routeApi.update(rule.id, { enabled: rule.enabled === false })
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Update failed"
  }
}

function providerName(id: string): string {
  return providers.value.find(p => p.id === id)?.name ?? id
}

async function moveUp(index: number) {
  if (index <= 0) return
  const list = [...rules.value]
  ;[list[index - 1], list[index]] = [list[index], list[index - 1]]
  await syncPriorities(list)
}

async function moveDown(index: number) {
  if (index >= rules.value.length - 1) return
  const list = [...rules.value]
  ;[list[index], list[index + 1]] = [list[index + 1], list[index]]
  await syncPriorities(list)
}

async function syncPriorities(reordered: RouteRuleInfo[]) {
  const updates = reordered.map((rule, i) => ({
    id: rule.id,
    priority: reordered.length - i,
  }))
  error.value = ""
  try {
    await routeApi.reorder(updates)
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Reorder failed"
    await load()
  }
}

function addCondition() {
  if (!form.value.contentMatch) form.value.contentMatch = []
  form.value.contentMatch.push({ type: "keyword", pattern: "", operator: form.value.contentMatch[0]?.operator ?? "and" })
}

function removeCondition(index: number) {
  form.value.contentMatch?.splice(index, 1)
  if (!form.value.contentMatch?.length) form.value.contentMatch = undefined
}

function syncOperator(event: Event) {
  const op = (event.target as HTMLSelectElement).value as "and" | "or"
  form.value.contentMatch?.forEach(c => c.operator = op)
}

function addExcludeCondition() {
  if (!form.value.excludeMatch) form.value.excludeMatch = []
  form.value.excludeMatch.push({ type: "keyword", pattern: "", operator: form.value.excludeMatch[0]?.operator ?? "and" })
}

function removeExcludeCondition(index: number) {
  form.value.excludeMatch?.splice(index, 1)
  if (!form.value.excludeMatch?.length) form.value.excludeMatch = undefined
}

function syncExcludeOperator(event: Event) {
  const op = (event.target as HTMLSelectElement).value as "and" | "or"
  form.value.excludeMatch?.forEach(c => c.operator = op)
}

function addFallback() {
  if (!form.value.fallbacks) form.value.fallbacks = []
  form.value.fallbacks.push({ providerId: "" })
}

function removeFallback(index: number) {
  form.value.fallbacks?.splice(index, 1)
  if (!form.value.fallbacks?.length) form.value.fallbacks = undefined
}

/** 各 fallback provider 的可用模型缓存 */
const fallbackModelsMap = computed(() => {
  const map = new Map<string, string[]>()
  for (const fb of form.value.fallbacks ?? []) {
    if (fb.providerId) {
      const models = providers.value.find(p => p.id === fb.providerId)?.models ?? []
      map.set(fb.providerId, models)
    }
  }
  return map
})

/** 获取 fallback provider 的可用模型列表 */
function fallbackProviderModels(providerId: string): string[] {
  return fallbackModelsMap.value.get(providerId) ?? []
}

/** 切换 keyGroup 选中状态 */
function toggleKeyGroup(groupId: string) {
  if (!form.value.keyGroups) form.value.keyGroups = []
  const idx = form.value.keyGroups.indexOf(groupId)
  if (idx >= 0) form.value.keyGroups.splice(idx, 1)
  else form.value.keyGroups.push(groupId)
}

/** modelMapping 条目列表（响应式代理） */
const mappingEntries = ref<{ source: string; target: string }[]>([])

/** 从 form.modelMapping 同步到 entries */
function syncMappingFromForm() {
  const map = form.value.modelMapping ?? {}
  mappingEntries.value = Object.entries(map).map(([source, target]) => ({ source, target }))
}

/** 添加一条映射 */
function addMapping() {
  mappingEntries.value.push({ source: "", target: "" })
}

/** 删除一条映射 */
function removeMapping(index: number) {
  mappingEntries.value.splice(index, 1)
  syncMappingToForm()
}

/** 将 entries 同步回 form.modelMapping */
function syncMappingToForm() {
  const map: Record<string, string> = {}
  for (const entry of mappingEntries.value) {
    if (entry.source) map[entry.source] = entry.target
  }
  form.value.modelMapping = map
}
</script>

<template>
  <div class="route-rules">
    <div class="toolbar">
      <h2>{{ t('route.title') }}</h2>
      <button class="btn btn-primary" @click="startCreate">{{ t('route.addRule') }}</button>
    </div>

    <div v-if="loading" class="loading">{{ t('route.loading') }}</div>

    <p v-if="error" class="error-text">{{ error }}</p>

    <div v-else>
      <table class="table" v-if="!creating">
        <thead>
          <tr>
            <th>{{ t('route.indexCol') }}</th>
            <th>{{ t('route.matchCol') }}</th>
            <th>{{ t('route.providerCol') }}</th>
            <th>{{ t('route.targetModelCol') }}</th>
            <th>{{ t('route.actionsCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(rule, idx) in rules" :key="rule.id" :class="{ disabled: rule.enabled === false }">
            <td>
              <div class="priority-cell">
                <button class="btn-icon" :disabled="idx === 0" @click="moveUp(idx)" :title="t('route.moveUp')">&#9650;</button>
                <span class="priority-num">{{ idx + 1 }}</span>
                <button class="btn-icon" :disabled="idx === rules.length - 1" @click="moveDown(idx)" :title="t('route.moveDown')">&#9660;</button>
              </div>
            </td>
            <td>
              <span v-if="rule.pattern && rule.pattern !== '*'" class="match-tag model">{{ t('route.modelLabel') }} <code>{{ rule.pattern }}</code></span>
              <span v-for="(cond, ci) in rule.contentMatch" :key="'cm'+ci" class="match-tag" :class="cond.type === 'content_type' ? 'media' : 'content'">
                <template v-if="cond.type === 'content_type'">
                  {{ cond.pattern === 'image' ? t('route.containsImage') : cond.pattern === 'file' ? t('route.containsFile') : cond.pattern === 'tool_use' ? t('route.containsToolUse') : cond.pattern }}
                </template>
                <template v-else>
                  {{ cond.type === 'keyword' ? t('route.contains') : t('route.match') }} "{{ cond.pattern }}"
                </template>
              </span>
              <span v-if="rule.excludeMatch?.length" class="exclude-group">
                <span class="exclude-prefix">{{ t('route.excludes') }}</span>
                <span class="exclude-conditions">
                  <span v-for="(cond, ci) in rule.excludeMatch" :key="'ex'+ci" class="match-tag exclude">
                    <template v-if="cond.type === 'content_type'">
                      {{ cond.pattern === 'image' ? t('route.containsImage') : cond.pattern === 'file' ? t('route.containsFile') : cond.pattern === 'tool_use' ? t('route.containsToolUse') : cond.pattern }}
                    </template>
                    <template v-else>
                      {{ cond.type === 'keyword' ? t('route.contains') : t('route.match') }} "{{ cond.pattern }}"
                    </template>
                  </span>
                </span>
              </span>
              <span v-if="(!rule.pattern || rule.pattern === '*') && !rule.contentMatch?.length" class="muted">{{ t('route.matchAll') }}</span>
              <span v-if="rule.keyGroups?.length" class="match-tag keygroup-label">{{ t('route.keyGroupsLabel') }}</span>
              <span v-for="kgid in rule.keyGroups" :key="kgid" class="match-tag keygroup">{{ keyGroups.find(g => g.id === kgid)?.name ?? kgid }}</span>
            </td>
            <td>
              <div>{{ providerName(rule.providerId) }}</div>
              <div v-if="rule.fallbacks?.length" class="fallback-list">
                <span class="fallback-arrow">&#x21B3;</span>
                <span v-for="(fb, fi) in rule.fallbacks" :key="fi" class="fallback-tag">
                  {{ providerName(fb.providerId) }}<template v-if="fb.targetModel"> → {{ fb.targetModel }}</template>
                </span>
                <span v-if="rule.fallbackOnClientError" class="fallback-tag fallback-tag-4xx">4xx</span>
              </div>
            </td>
            <td>
              <span v-if="rule.targetModel">{{ rule.targetModel }}</span>
              <span v-else class="muted">{{ t('route.originalModel') }}</span>
            </td>
            <td>
              <div class="actions-cell">
                <label class="toggle" :title="rule.enabled !== false ? t('route.enabled') : t('route.disabled')">
                  <input type="checkbox" :checked="rule.enabled !== false" @change="toggleEnabled(rule)" />
                  <span class="toggle-slider"></span>
                </label>
                <button class="btn-sm" @click="startEdit(rule)">{{ t('route.edit') }}</button>
                <button class="btn-sm btn-danger" @click="remove(rule.id)">{{ t('route.delete') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="rules.length === 0 && !creating" class="empty">{{ t('route.noRules') }}</div>

      <div v-if="creating" class="form-card">
        <h3>{{ editingId ? t('route.editTitle') : t('route.addTitle') }}</h3>

        <!-- 服务商 & 目标模型 -->
        <div class="form-grid">
          <label>
            {{ t('route.providerLabel') }}
            <select v-model="form.providerId">
              <option value="" disabled>{{ t('route.selectProvider') }}</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <label v-if="providerModels.length">
            {{ t('route.targetModelLabel') }}
            <select v-model="form.targetModel">
              <option value="">{{ t('route.useOriginalModel') }}</option>
              <option v-for="m in providerModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
          <label v-else>
            {{ t('route.targetModelLabel') }}
            <input v-model="form.targetModel" :placeholder="t('route.targetModelPlaceholder')" />
          </label>
        </div>

        <!-- 模型映射 -->
        <div class="match-section">
          <div class="section-label">{{ t('route.modelMappingLabel') }}</div>
          <p class="section-hint">{{ t('route.modelMappingHint') }}</p>
          <div v-for="(entry, i) in mappingEntries" :key="i" class="condition-row indented">
            <input v-model="entry.source" :placeholder="t('route.modelMappingSource')" class="cond-pattern" @input="syncMappingToForm" />
            <span class="mapping-arrow">→</span>
            <input v-model="entry.target" :placeholder="t('route.modelMappingTarget')" class="cond-pattern" @input="syncMappingToForm" />
            <button class="btn-sm btn-danger" type="button" @click="removeMapping(i)">&times;</button>
          </div>
          <button class="btn-sm" type="button" @click="addMapping" style="margin-left: 24px">{{ t('route.addMapping') }}</button>
        </div>

        <!-- 排除条件（优先级高于匹配条件） -->
        <div class="match-section">
          <div class="section-label">{{ t('route.excludeConditionLabel') }}<span class="section-hint" style="margin: 0 0 0 8px; display: inline">{{ t('route.excludePriorityHint') }}</span></div>

          <div class="condition-row">
            <label class="checkbox-label">
              <input type="checkbox" :checked="!!form.excludeMatch?.length" @change="($event.target as HTMLInputElement).checked ? addExcludeCondition() : (form.excludeMatch = undefined)" />
              {{ t('route.excludeByContent') }}
            </label>
          </div>

          <div v-if="form.excludeMatch?.length" class="content-conditions">
            <div v-if="form.excludeMatch.length > 1" class="operator-select">
              <select :value="form.excludeMatch[0].operator ?? 'and'" @change="syncExcludeOperator($event)">
                <option value="and">{{ t('route.matchAllAnd') }}</option>
                <option value="or">{{ t('route.matchAnyOr') }}</option>
              </select>
            </div>

            <div v-for="(cond, i) in form.excludeMatch" :key="i" class="condition-row indented">
              <select v-model="cond.type" class="cond-type">
                <option value="keyword">{{ t('route.keyword') }}</option>
                <option value="regex">{{ t('route.regex') }}</option>
                <option value="content_type">{{ t('route.contentType') }}</option>
              </select>
              <select
                v-if="cond.type === 'content_type'"
                v-model="cond.pattern"
                class="cond-pattern"
              >
                <option value="image">{{ t('route.containsImage') }}</option>
                <option value="file">{{ t('route.containsFile') }}</option>
                <option value="tool_use">{{ t('route.containsToolUse') }}</option>
              </select>
              <input
                v-else
                v-model="cond.pattern"
                :placeholder="cond.type === 'keyword' ? t('route.keywordPlaceholder') : t('route.regexPlaceholder')"
                class="cond-pattern"
              />
              <input
                v-if="cond.type === 'regex'"
                v-model="cond.flags"
                placeholder="flags"
                class="cond-flags"
              />
              <button class="btn-sm btn-danger" type="button" @click="removeExcludeCondition(i)">&times;</button>
            </div>

            <button class="btn-sm" type="button" @click="addExcludeCondition" style="margin-left: 24px">{{ t('route.addExclude') }}</button>
          </div>
        </div>

        <!-- 匹配条件 -->
        <div class="match-section">
          <div class="section-label">{{ t('route.matchConditionLabel') }}</div>

          <!-- 模型名匹配 -->
          <div class="condition-row">
            <label class="checkbox-label">
              <input type="checkbox" :checked="!!form.pattern" @change="form.pattern = ($event.target as HTMLInputElement).checked ? '*' : ''" />
              {{ t('route.matchByModel') }}
            </label>
            <input v-if="form.pattern" v-model="form.pattern" placeholder="gpt-*" class="cond-pattern" />
          </div>

          <!-- 内容匹配 -->
          <div class="condition-row">
            <label class="checkbox-label">
              <input type="checkbox" :checked="!!form.contentMatch?.length" @change="($event.target as HTMLInputElement).checked ? addCondition() : (form.contentMatch = undefined)" />
              {{ t('route.matchByContent') }}
            </label>
          </div>

          <div v-if="form.contentMatch?.length" class="content-conditions">
            <div v-if="form.contentMatch.length > 1" class="operator-select">
              <select :value="form.contentMatch[0].operator ?? 'and'" @change="syncOperator($event)">
                <option value="and">{{ t('route.matchAllAnd') }}</option>
                <option value="or">{{ t('route.matchAnyOr') }}</option>
              </select>
            </div>

            <div v-for="(cond, i) in form.contentMatch" :key="i" class="condition-row indented">
              <select v-model="cond.type" class="cond-type">
                <option value="keyword">{{ t('route.keyword') }}</option>
                <option value="regex">{{ t('route.regex') }}</option>
                <option value="content_type">{{ t('route.contentType') }}</option>
              </select>
              <select
                v-if="cond.type === 'content_type'"
                v-model="cond.pattern"
                class="cond-pattern"
              >
                <option value="image">{{ t('route.containsImage') }}</option>
                <option value="file">{{ t('route.containsFile') }}</option>
                <option value="tool_use">{{ t('route.containsToolUse') }}</option>
              </select>
              <input
                v-else
                v-model="cond.pattern"
                :placeholder="cond.type === 'keyword' ? t('route.keywordPlaceholder') : t('route.regexPlaceholder')"
                class="cond-pattern"
              />
              <input
                v-if="cond.type === 'regex'"
                v-model="cond.flags"
                placeholder="flags"
                class="cond-flags"
              />
              <button class="btn-sm btn-danger" type="button" @click="removeCondition(i)">&times;</button>
            </div>

            <button class="btn-sm" type="button" @click="addCondition" style="margin-left: 24px">{{ t('route.addCondition') }}</button>
          </div>
        </div>

        <!-- 密钥分组限制 -->
        <div v-if="keyGroups.length" class="match-section">
          <div class="section-label">{{ t('route.keyGroupsLabel') }}</div>
          <p class="section-hint">{{ t('route.keyGroupsHint') }}</p>
          <div class="key-groups-grid">
            <label v-for="g in keyGroups" :key="g.id" class="checkbox-label">
              <input type="checkbox" :checked="form.keyGroups?.includes(g.id)" @change="toggleKeyGroup(g.id)" />
              {{ g.name }}
            </label>
          </div>
        </div>

        <!-- 故障转移 -->
        <div class="match-section">
          <div class="section-label">{{ t('route.fallbackLabel') }}</div>
          <p class="section-hint">{{ t('route.fallbackHint') }}</p>

          <label class="checkbox-label" style="margin-bottom: 10px">
            <input type="checkbox" v-model="form.fallbackOnClientError" />
            {{ t('route.fallbackOnClientError') }}
          </label>
          <p class="section-hint" style="margin-top: -6px; margin-bottom: 10px">{{ t('route.fallbackOnClientErrorHint') }}</p>

          <div v-for="(fb, i) in form.fallbacks" :key="i" class="condition-row indented fallback-row">
            <select v-model="fb.providerId" class="cond-type">
              <option value="" disabled>{{ t('route.selectProvider') }}</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <select v-if="fallbackProviderModels(fb.providerId).length" v-model="fb.targetModel" class="cond-pattern">
              <option value="">{{ t('route.useOriginalModel') }}</option>
              <option v-for="m in fallbackProviderModels(fb.providerId)" :key="m" :value="m">{{ m }}</option>
            </select>
            <input v-else v-model="fb.targetModel" :placeholder="t('route.targetModelPlaceholder')" class="cond-pattern" />
            <button class="btn-sm btn-danger" type="button" @click="removeFallback(i)">&times;</button>
          </div>

          <button class="btn-sm" type="button" @click="addFallback" style="margin-left: 24px">{{ t('route.addFallback') }}</button>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" @click="save" :disabled="saving">{{ saving ? '...' : t('route.save') }}</button>
          <button class="btn" @click="cancel">{{ t('route.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/** 表单内输入框/下拉框统一样式 */
.form-card input[type="text"],
.form-card input:not([type]) {
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  transition: border-color 0.15s;
}

.form-card input[type="text"]:focus,
.form-card input:not([type]):focus {
  outline: none;
  border-color: var(--primary);
}

.form-card select {
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 24px;
}

.form-card select:focus {
  outline: none;
  border-color: var(--primary);
}

.form-card .btn-sm {
  padding: 5px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.form-card .btn-sm:hover {
  background: var(--surface2);
  color: var(--text);
}

.form-card .btn-sm.btn-danger {
  color: var(--danger);
  border-color: transparent;
  background: transparent;
  padding: 5px 8px;
  font-size: 16px;
  line-height: 1;
}

.form-card .btn-sm.btn-danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

.match-section {
  margin-top: 16px;
  padding: 16px;
  background: var(--bg);
  border-radius: 8px;
  border: 1px solid var(--border);
}

.section-label {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-dim);
}

.condition-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}

.condition-row.indented {
  margin-left: 24px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-dim);
}

.checkbox-label input[type="checkbox"] {
  margin: 0;
  width: 15px;
  height: 15px;
  accent-color: var(--primary);
  cursor: pointer;
}

.cond-type {
  width: 140px;
  min-width: 140px;
}

.cond-pattern {
  flex: 1;
  min-width: 0;
}

.cond-flags {
  width: 80px;
}

.operator-select select {
  padding: 4px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 24px;
}

.content-conditions {
  margin-top: 4px;
}

.match-tag {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  margin-right: 4px;
}

.match-tag.model {
  background: var(--tag-blue-bg);
  color: var(--tag-blue);
}

.match-tag.content {
  background: var(--tag-purple-bg);
  color: var(--tag-purple);
}

.match-tag.media {
  background: var(--tag-green-bg);
  color: var(--tag-green);
}

.match-tag.exclude {
  background: var(--tag-red-bg);
  color: var(--tag-red);
}

/** 排除规则整体分组：前缀标签 + 竖线 + 条件列表 */
.exclude-group {
  display: inline-flex;
  align-items: center;
  background: var(--tag-red-bg);
  border-radius: 4px;
  overflow: hidden;
  margin-right: 4px;
  vertical-align: top;
}

.exclude-prefix {
  padding: 2px 8px;
  color: var(--tag-red);
  font-weight: 600;
  font-size: 12px;
  background: rgba(239, 68, 68, 0.15);
  border-right: 1px solid var(--tag-red);
}

.exclude-conditions {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 0;
  padding: 2px 6px;
}

.priority-cell {
  display: flex;
  align-items: center;
  gap: 2px;
}

.priority-num {
  min-width: 20px;
  text-align: center;
  font-weight: 600;
}

.btn-icon {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 6px;
  font-size: 10px;
  color: var(--text-dim);
  border-radius: 4px;
  transition: all 0.15s;
}

.btn-icon:hover:not(:disabled) {
  background: var(--surface2);
  color: var(--text);
}

.btn-icon:disabled {
  opacity: 0.25;
  cursor: default;
}

.actions-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

tr.disabled {
  opacity: 0.45;
}

/** 匹配规则列不截断，允许完整显示所有 tag */
.table td:nth-child(2) {
  max-width: none;
  overflow: visible;
  white-space: normal;
}

.section-hint {
  font-size: 12px;
  color: var(--text-dim);
  margin: -8px 0 12px;
  opacity: 0.7;
}

.fallback-row {
  margin-bottom: 6px;
}

.fallback-list {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-dim);
}

.fallback-arrow {
  margin-right: 4px;
  color: var(--primary);
}

.fallback-tag {
  display: inline-block;
  background: var(--tag-blue-bg);
  color: var(--tag-blue);
  padding: 1px 6px;
  border-radius: 3px;
  margin-right: 4px;
  font-size: 11px;
}

.fallback-tag-4xx {
  background: var(--tag-orange-bg, #fff3e0);
  color: var(--tag-orange, #e65100);
}

.key-groups-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding-left: 4px;
}

.match-tag.keygroup-label {
  background: var(--tag-red-bg);
  color: var(--tag-red);
  font-weight: 600;
}

.match-tag.keygroup {
  background: var(--tag-green-bg);
  color: var(--tag-green);
}

.mapping-arrow {
  color: var(--text-dim);
  font-weight: 600;
  font-size: 16px;
  opacity: 0.5;
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
  .form-card {
    padding: 14px 10px;
  }
  .match-section {
    padding: 12px 8px;
  }
  .condition-row {
    flex-wrap: wrap;
    gap: 6px;
  }
  .condition-row.indented {
    margin-left: 8px;
  }
  .cond-type {
    width: 100%;
    min-width: 0;
  }
  .cond-pattern {
    min-width: 0;
  }
  .cond-flags {
    width: 60px;
  }
  .table {
    display: block;
    overflow-x: auto;
    min-width: 600px;
  }
  .key-groups-grid {
    gap: 8px;
  }
}
</style>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue"
import { routeApi, providerApi, type RouteRuleInfo, type ProviderInfo } from "../api"
import { t } from "../i18n"

const rules = ref<RouteRuleInfo[]>([])
const providers = ref<ProviderInfo[]>([])
const loading = ref(true)
const creating = ref(false)
const editingId = ref<string | null>(null)

const emptyRule: Omit<RouteRuleInfo, "id"> = {
  pattern: "",
  providerId: "",
  targetModel: "",
  modelMapping: {},
  priority: 0,
  contentMatch: [],
  excludeMatch: [],
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
  const [r, p] = await Promise.all([routeApi.list(), providerApi.list()])
  rules.value = r
  providers.value = p
  loading.value = false
}

function startCreate() {
  editingId.value = null
  creating.value = true
  form.value = { ...emptyRule, contentMatch: [], excludeMatch: [] }
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
  }
}

function cancel() {
  editingId.value = null
  creating.value = false
}

async function save() {
  const data = { ...form.value }
  if (!data.contentMatch?.length) data.contentMatch = undefined
  if (!data.excludeMatch?.length) data.excludeMatch = undefined
  if (!data.targetModel) data.targetModel = undefined
  if (!data.pattern) data.pattern = ""
  if (editingId.value) {
    await routeApi.update(editingId.value, data)
  } else {
    await routeApi.create(data)
  }
  cancel()
  await load()
}

async function remove(id: string) {
  await routeApi.delete(id)
  await load()
}

async function toggleEnabled(rule: RouteRuleInfo) {
  await routeApi.update(rule.id, { enabled: rule.enabled === false })
  await load()
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
  await Promise.all(updates.map(u => routeApi.update(u.id, { priority: u.priority })))
  await load()
}

function addCondition() {
  if (!form.value.contentMatch) form.value.contentMatch = []
  form.value.contentMatch.push({ type: "keyword", pattern: "", operator: form.value.contentMatch[0]?.operator ?? "and" })
}

function removeCondition(index: number) {
  form.value.contentMatch?.splice(index, 1)
  if (!form.value.contentMatch?.length) form.value.contentMatch = undefined
}

function syncOperator() {
  const op = form.value.contentMatch?.[0]?.operator ?? "and"
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

function syncExcludeOperator() {
  const op = form.value.excludeMatch?.[0]?.operator ?? "and"
  form.value.excludeMatch?.forEach(c => c.operator = op)
}
</script>

<template>
  <div class="route-rules">
    <div class="toolbar">
      <h2>{{ t('route.title') }}</h2>
      <button class="btn btn-primary" @click="startCreate">{{ t('route.addRule') }}</button>
    </div>

    <div v-if="loading" class="loading">{{ t('route.loading') }}</div>

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
              <span v-if="rule.excludeMatch?.length" class="match-tag exclude-label">{{ t('route.excludes') }}</span>
              <span v-for="(cond, ci) in rule.excludeMatch" :key="'ex'+ci" class="match-tag exclude">
                <template v-if="cond.type === 'content_type'">
                  {{ cond.pattern === 'image' ? t('route.containsImage') : cond.pattern === 'file' ? t('route.containsFile') : cond.pattern === 'tool_use' ? t('route.containsToolUse') : cond.pattern }}
                </template>
                <template v-else>
                  {{ cond.type === 'keyword' ? t('route.contains') : t('route.match') }} "{{ cond.pattern }}"
                </template>
              </span>
              <span v-if="(!rule.pattern || rule.pattern === '*') && !rule.contentMatch?.length" class="muted">{{ t('route.matchAll') }}</span>
            </td>
            <td>{{ providerName(rule.providerId) }}</td>
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
              <select :value="form.contentMatch[0].operator ?? 'and'" @change="syncOperator()">
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

        <!-- 排除条件 -->
        <div class="match-section">
          <div class="section-label">{{ t('route.excludeConditionLabel') }}</div>

          <div class="condition-row">
            <label class="checkbox-label">
              <input type="checkbox" :checked="!!form.excludeMatch?.length" @change="($event.target as HTMLInputElement).checked ? addExcludeCondition() : (form.excludeMatch = undefined)" />
              {{ t('route.excludeByContent') }}
            </label>
          </div>

          <div v-if="form.excludeMatch?.length" class="content-conditions">
            <div v-if="form.excludeMatch.length > 1" class="operator-select">
              <select :value="form.excludeMatch[0].operator ?? 'and'" @change="syncExcludeOperator()">
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

        <div class="form-actions">
          <button class="btn btn-primary" @click="save">{{ t('route.save') }}</button>
          <button class="btn" @click="cancel">{{ t('route.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.match-section {
  margin-top: 16px;
  padding: 12px;
  background: var(--surface);
  border-radius: 6px;
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
  font-size: 14px;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  margin: 0;
}

.cond-type {
  width: 120px;
}

.cond-pattern {
  flex: 1;
}

.cond-flags {
  width: 80px;
}

.operator-select {
  margin-bottom: 8px;
  margin-left: 24px;
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

.match-tag.exclude-label {
  background: var(--tag-red-bg);
  color: var(--tag-red);
  font-weight: 600;
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
  padding: 2px 4px;
  font-size: 10px;
  color: var(--text-dim);
  border-radius: 3px;
}

.btn-icon:hover:not(:disabled) {
  background: var(--surface2);
  color: inherit;
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

/** Toggle 开关 */
.toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--border);
  border-radius: 10px;
  transition: background 0.2s;
}

.toggle-slider::before {
  content: "";
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background: var(--text-dim);
  border-radius: 50%;
  transition: transform 0.2s, background 0.2s;
}

.toggle input:checked + .toggle-slider {
  background: var(--primary);
}

.toggle input:checked + .toggle-slider::before {
  transform: translateX(16px);
  background: #fff;
}

tr.disabled {
  opacity: 0.45;
}
</style>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue"
import { rewriteApi, logApi, type RewriteRuleInfo, type RewriteAction, type RewritePreviewItem, type RewritePreviewStep, type LogEntry, type LogToolInfo } from "../api"
import { t } from "../i18n"
import { diffWords } from "../utils/diff"

const rules = ref<RewriteRuleInfo[]>([])
const loading = ref(true)
const creating = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const error = ref("")

const emptyRule: Omit<RewriteRuleInfo, "id" | "createdAt"> = {
  name: "",
  match: [],
  actions: [{ type: "regex_replace", replacement: "" }],
  enabled: true,
  priority: 0,
}

const form = ref<Omit<RewriteRuleInfo, "id" | "createdAt">>({ ...emptyRule })

onMounted(load)

async function load() {
  loading.value = true
  error.value = ""
  try {
    rules.value = await rewriteApi.list()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Failed to load"
  }
  loading.value = false
}

function startCreate() {
  editingId.value = null
  creating.value = true
  form.value = {
    ...emptyRule,
    match: [],
    actions: [{ type: "regex_replace", replacement: "" }],
  }
  previewResults.value = []
  showLogSelector.value = false
}

function startEdit(rule: RewriteRuleInfo) {
  editingId.value = rule.id
  creating.value = true
  form.value = {
    name: rule.name,
    match: rule.match ? rule.match.map(c => ({ ...c })) : [],
    actions: rule.actions?.length
      ? rule.actions.map(a => ({ ...a }))
      : [{ type: "regex_replace" as const, replacement: "" }],
    enabled: rule.enabled,
    priority: rule.priority,
    modelPattern: rule.modelPattern ?? "",
    pathPattern: rule.pathPattern ?? "",
  }
  previewResults.value = []
  showLogSelector.value = false
}

function cancel() {
  editingId.value = null
  creating.value = false
  previewResults.value = []
  showLogSelector.value = false
  showToolPicker.value = false
  pickedLogTools.value = []
}

async function save() {
  const data = { ...form.value }
  if (!data.name) { error.value = t('rewrites.errorNameRequired'); return }
  if (!data.actions?.length) { error.value = t('rewrites.errorActionRequired'); return }
  if (!data.modelPattern) data.modelPattern = undefined
  if (!data.pathPattern) data.pathPattern = undefined
  error.value = ""
  saving.value = true
  try {
    if (editingId.value) {
      await rewriteApi.update(editingId.value, data)
    } else {
      await rewriteApi.create(data)
    }
    cancel()
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Save failed"
  }
  saving.value = false
}

async function remove(id: string) {
  if (!confirm(t('rewrites.confirmDelete'))) return
  error.value = ""
  try {
    await rewriteApi.delete(id)
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Delete failed"
  }
}

async function toggleEnabled(rule: RewriteRuleInfo) {
  error.value = ""
  try {
    await rewriteApi.update(rule.id, { enabled: !rule.enabled })
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Update failed"
  }
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

async function syncPriorities(reordered: RewriteRuleInfo[]) {
  const updates = reordered.map((rule, i) => ({
    id: rule.id,
    priority: reordered.length - i,
  }))
  error.value = ""
  try {
    await rewriteApi.reorder(updates)
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Reorder failed"
    await load()
  }
}

/** 匹配条件管理 */
function addCondition() {
  if (!form.value.match) form.value.match = []
  form.value.match.push({ type: "keyword", pattern: "", operator: form.value.match[0]?.operator ?? "and" })
}

function removeCondition(index: number) {
  form.value.match?.splice(index, 1)
}

function syncOperator(event: Event) {
  const op = (event.target as HTMLSelectElement).value as "and" | "or"
  form.value.match?.forEach(c => c.operator = op)
}

/** 动作组管理 */
function addAction() {
  if (!form.value.actions) form.value.actions = []
  form.value.actions.push({ type: "regex_replace", replacement: "" })
}

/** 新建一个 remove_tool 动作 */
function addRemoveToolAction() {
  if (!form.value.actions) form.value.actions = []
  form.value.actions.push({ type: "remove_tool", replacement: "", toolField: "name", toolMatchMode: "exact" })
}

function removeAction(index: number) {
  form.value.actions?.splice(index, 1)
}

/** 从日志勾选工具：选中某条日志 → 列出其中的工具声明 → 勾选生成 exact 匹配的 remove_tool 动作 */
const showToolPicker = ref(false)
const toolPickerLogs = ref<LogEntry[]>([])
const toolPickerLoading = ref(false)
const pickedLogTools = ref<LogToolInfo[]>([])
const checkedToolNames = ref<Set<string>>(new Set())
const toolSearch = ref("")

async function openToolPicker() {
  showToolPicker.value = true
  try {
    toolPickerLogs.value = await logApi.list({ limit: 20, sort: "time_desc" })
  } catch { /* silent */ }
}

async function loadLogTools(logId: number) {
  toolPickerLoading.value = true
  try {
    const resp = await rewriteApi.logTools(logId)
    pickedLogTools.value = resp.tools
    checkedToolNames.value = new Set()
    toolSearch.value = ""
    if (!resp.tools.length) error.value = t('rewrites.noToolsInLog')
  } catch { /* silent */ }
  toolPickerLoading.value = false
}

const filteredLogTools = computed(() => {
  if (!toolSearch.value) return pickedLogTools.value
  const q = toolSearch.value.toLowerCase()
  return pickedLogTools.value.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
})

function toggleToolChecked(name: string) {
  if (checkedToolNames.value.has(name)) checkedToolNames.value.delete(name)
  else checkedToolNames.value.add(name)
}

function confirmAddRemoveActions() {
  for (const name of checkedToolNames.value) {
    form.value.actions.push({ type: "remove_tool", replacement: "", toolField: "name", toolMatchMode: "exact", pattern: name, name })
  }
  checkedToolNames.value = new Set()
  pickedLogTools.value = []
  showToolPicker.value = false
}

/** 日志预览 */
const showLogSelector = ref(false)
const recentLogs = ref<LogEntry[]>([])
const selectedLogIds = ref<Set<number>>(new Set())
const previewResults = ref<RewritePreviewItem[]>([])
const previewLoading = ref(false)

async function openLogSelector() {
  showLogSelector.value = true
  try {
    recentLogs.value = await logApi.list({ limit: 20, sort: "time_desc" })
  } catch { /* silent */ }
}

function toggleLogSelect(id: number) {
  if (selectedLogIds.value.has(id)) {
    selectedLogIds.value.delete(id)
  } else if (selectedLogIds.value.size < 10) {
    selectedLogIds.value.add(id)
  }
}

async function executePreview() {
  await runPreview([...selectedLogIds.value])
}

/** 上次预览使用的日志 ID，供响应式刷新复用 */
let lastPreviewLogIds: number[] = []

/** 执行预览：silent = 表单变化触发的自动刷新（不收起选择器、不报错打断输入） */
async function runPreview(ids: number[], silent = false) {
  if (!ids.length) return
  previewLoading.value = true
  try {
    /** 传入当前表单中的临时规则定义 */
    const resp = await rewriteApi.preview({
      rule: {
        name: form.value.name || "preview",
        match: form.value.match,
        actions: form.value.actions,
        enabled: true,
        priority: 0,
        modelPattern: form.value.modelPattern || undefined,
        pathPattern: form.value.pathPattern || undefined,
      },
      logIds: ids,
    })
    previewResults.value = resp.results
    lastPreviewLogIds = ids
    showLogSelector.value = false
  } catch (e: unknown) {
    if (!silent) error.value = e instanceof Error ? e.message : "Preview failed"
  }
  previewLoading.value = false
}

/** 响应式预览：表单变化后延迟自动刷新预览结果 */
let refreshTimer: ReturnType<typeof setTimeout> | null = null
watch(form, () => {
  if (!lastPreviewLogIds.length) return
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { void runPreview(lastPreviewLogIds, true) }, 400)
}, { deep: true })

/** 预览视图：预计算每个步骤的 diff 片段和增删统计 */
interface StepView {
  step: RewritePreviewStep
  index: number
  spans: { text: string; type: "same" | "add" | "del" }[]
  addChars: number
  delChars: number
  changed: boolean
}

const previewViews = computed(() => previewResults.value.map(item => {
  const stepViews: StepView[] = item.steps.map((step, index) => {
    const spans = step.before === step.after ? [] : diffWords(step.before, step.after)
    let addChars = 0, delChars = 0
    for (const s of spans) {
      if (s.type === "add") addChars += s.text.trim().length
      else if (s.type === "del") delChars += s.text.trim().length
    }
    return { step, index, spans, addChars, delChars, changed: step.before !== step.after }
  })
  return { item, stepViews, changedStepViews: stepViews.filter(s => s.changed) }
}))

/** 滚动定位到某个改动步骤（Git diff 式快速导航） */
function jumpToChange(logId: number, stepIndex: number) {
  document.getElementById(`preview-step-${logId}-${stepIndex}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
}

/** 动作标签文本 */
function actionTag(type: string): string {
  const map: Record<string, string> = {
    regex_replace: t('rewrites.actionTagRegexReplace'),
    text_replace: t('rewrites.actionTagTextReplace'),
    prepend: t('rewrites.actionTagPrepend'),
    append: t('rewrites.actionTagAppend'),
    remove_tool: t('rewrites.actionTagRemoveTool'),
  }
  return map[type] ?? type
}

/** remove_tool 动作的规则列表描述文本 */
function removeToolDetail(act: RewriteAction): string {
  const fieldMap: Record<string, string> = { name: t('rewrites.toolFieldName'), description: t('rewrites.toolFieldDescription'), input_schema: t('rewrites.toolFieldSchema') }
  const modeMap: Record<string, string> = { exact: "", contains: `${t('rewrites.modeContains')} · `, regex: `${t('rewrites.modeRegex')} · ` }
  return `${fieldMap[act.toolField ?? "name"]} · ${modeMap[act.toolMatchMode ?? "exact"]}${act.pattern || ""}`
}

function formatTime(ts: string): string {
  if (!ts) return ""
  try {
    const d = new Date(ts + (ts.includes("Z") || ts.includes("+") ? "" : "Z"))
    return d.toLocaleString()
  } catch {
    return ts
  }
}
</script>

<template>
  <div class="route-rules">
    <div class="toolbar">
      <h2>{{ t('rewrites.title') }}</h2>
      <button class="btn btn-primary" @click="startCreate">{{ t('rewrites.addRule') }}</button>
    </div>

    <div v-if="loading" class="loading">Loading...</div>

    <p v-if="error" class="error-text">{{ error }}</p>

    <div v-if="!loading">
      <table class="table" v-if="!creating">
        <thead>
          <tr>
            <th>#</th>
            <th>{{ t('rewrites.ruleName') }}</th>
            <th>{{ t('rewrites.applyConditionLabel') }}</th>
            <th>{{ t('rewrites.actionLabel') }}</th>
            <th>{{ t('rewrites.actionsCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(rule, idx) in rules" :key="rule.id" :class="{ disabled: rule.enabled === false }">
            <td>
              <div class="priority-cell">
                <button class="btn-icon" :disabled="idx === 0" @click="moveUp(idx)">&#9650;</button>
                <span class="priority-num">{{ idx + 1 }}</span>
                <button class="btn-icon" :disabled="idx === rules.length - 1" @click="moveDown(idx)">&#9660;</button>
              </div>
            </td>
            <td>
              <strong>{{ rule.name }}</strong>
              <div v-if="rule.modelPattern || rule.pathPattern" class="scope-tags">
                <span v-if="rule.modelPattern" class="match-tag model">{{ t('rewrites.modelFilter') }}: {{ rule.modelPattern }}</span>
                <span v-if="rule.pathPattern" class="match-tag model">{{ t('rewrites.pathFilter') }}: {{ rule.pathPattern }}</span>
              </div>
            </td>
            <td>
              <span v-for="(cond, ci) in rule.match" :key="ci" class="match-tag" :class="cond.type === 'keyword' ? 'content' : 'media'">
                {{ cond.type === 'keyword' ? t('rewrites.keyword') : t('rewrites.regex') }} "{{ cond.pattern }}"
                <template v-if="cond.scope && cond.scope !== 'all'">[{{ cond.scope }}]</template>
              </span>
              <span v-if="!rule.match?.length" class="muted">-</span>
            </td>
            <td>
              <div v-for="(act, ai) in rule.actions" :key="ai" class="action-line">
                <span class="action-tag" :class="'action-' + act.type">{{ actionTag(act.type) }}</span>
                <span v-if="act.name" class="action-name">{{ act.name }}</span>
                <span v-if="act.type === 'remove_tool'" class="action-detail">{{ removeToolDetail(act) }}</span>
                <span v-else-if="act.type === 'regex_replace' || act.type === 'text_replace'" class="action-detail">
                  "{{ act.pattern || '' }}" → "{{ act.replacement }}"
                </span>
                <span v-else class="action-detail">"{{ act.replacement.slice(0, 50) }}{{ act.replacement.length > 50 ? '...' : '' }}"</span>
              </div>
              <span v-if="!rule.actions?.length" class="muted">-</span>
            </td>
            <td>
              <div class="actions-cell">
                <label class="toggle" :title="rule.enabled !== false ? t('rewrites.enabled') : t('rewrites.disabled')">
                  <input type="checkbox" :checked="rule.enabled !== false" @change="toggleEnabled(rule)" />
                  <span class="toggle-slider"></span>
                </label>
                <button class="btn-sm" @click="startEdit(rule)">{{ t('rewrites.save') === 'Save' ? 'Edit' : '编辑' }}</button>
                <button class="btn-sm btn-danger" @click="remove(rule.id)">{{ t('rewrites.cancel') === 'Cancel' ? 'Delete' : '删除' }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="rules.length === 0 && !creating" class="empty">{{ t('rewrites.noRules') }}</div>

      <!-- 编辑/新建表单 -->
      <div v-if="creating" class="form-card">
        <h3>{{ editingId ? t('rewrites.editTitle') : t('rewrites.addTitle') }}</h3>

        <!-- 规则名称 -->
        <div class="form-grid">
          <label>
            {{ t('rewrites.ruleName') }}
            <input v-model="form.name" :placeholder="t('rewrites.ruleNamePlaceholder')" />
          </label>
        </div>

        <!-- 生效条件 -->
        <div class="match-section">
          <div class="section-label">{{ t('rewrites.applyConditionLabel') }}</div>
          <p class="section-hint">{{ t('rewrites.applyConditionHint') }}</p>

          <!-- 模型过滤 -->
          <div class="condition-row">
            <label class="checkbox-label">
              <input type="checkbox" :checked="!!form.modelPattern" @change="form.modelPattern = ($event.target as HTMLInputElement).checked ? '*' : ''" />
              {{ t('rewrites.matchByModel') }}
            </label>
            <input v-if="form.modelPattern" v-model="form.modelPattern" :placeholder="t('rewrites.modelPatternPlaceholder')" class="cond-pattern" />
          </div>

          <!-- 路径过滤 -->
          <div class="condition-row">
            <label class="checkbox-label">
              <input type="checkbox" :checked="!!form.pathPattern" @change="form.pathPattern = ($event.target as HTMLInputElement).checked ? '/v1/*' : ''" />
              {{ t('rewrites.matchByPath') }}
            </label>
            <input v-if="form.pathPattern" v-model="form.pathPattern" :placeholder="t('rewrites.pathPatternPlaceholder')" class="cond-pattern" />
          </div>

          <!-- 内容匹配条件 -->
          <div class="condition-row" style="margin-top: 8px">
            <label class="checkbox-label">
              <input type="checkbox" :checked="!!form.match?.length" @change="($event.target as HTMLInputElement).checked ? addCondition() : (form.match = [])" />
              {{ t('rewrites.matchByContent') }}
            </label>
          </div>

          <div v-if="form.match?.length" class="content-conditions">
            <div v-if="form.match.length > 1" class="operator-select">
              <select :value="form.match[0].operator ?? 'and'" @change="syncOperator($event)">
                <option value="and">{{ t('rewrites.matchAllAnd') }}</option>
                <option value="or">{{ t('rewrites.matchAnyOr') }}</option>
              </select>
            </div>

            <div v-for="(cond, i) in form.match" :key="i" class="condition-row indented">
              <select v-model="cond.type" class="cond-type">
                <option value="keyword">{{ t('rewrites.keyword') }}</option>
                <option value="regex">{{ t('rewrites.regex') }}</option>
              </select>
              <input
                v-model="cond.pattern"
                :placeholder="cond.type === 'keyword' ? t('rewrites.keywordPlaceholder') : t('rewrites.regexPlaceholder')"
                class="cond-pattern"
              />
              <input
                v-if="cond.type === 'regex'"
                v-model="cond.flags"
                placeholder="flags"
                class="cond-flags"
              />
              <select v-model="cond.scope" class="cond-scope">
                <option value="all">{{ t('rewrites.scopeAll') }}</option>
                <option value="system">{{ t('rewrites.scopeSystem') }}</option>
                <option value="user">{{ t('rewrites.scopeUser') }}</option>
                <option value="assistant">{{ t('rewrites.scopeAssistant') }}</option>
              </select>
              <button class="btn-sm btn-danger" type="button" @click="removeCondition(i)">&times;</button>
            </div>

            <button class="btn-sm" type="button" @click="addCondition" style="margin-left: 24px">{{ t('rewrites.addCondition') }}</button>
          </div>
        </div>

        <!-- 执行动作组 -->
        <div class="match-section">
          <div class="section-label">{{ t('rewrites.actionLabel') }}</div>

          <div v-for="(act, i) in form.actions" :key="i" class="action-editor">
            <div class="action-editor-header">
              <span class="action-index">#{{ i + 1 }}</span>
              <button v-if="form.actions.length > 1" class="btn-sm btn-danger" type="button" @click="removeAction(i)">&times;</button>
            </div>

            <div class="condition-row">
              <label>
                {{ t('rewrites.actionNameLabel') }}
                <input v-model="act.name" :placeholder="t('rewrites.actionNamePlaceholder')" class="cond-pattern" />
              </label>
            </div>

            <div class="condition-row">
              <label>
                {{ t('rewrites.actionType') }}
                <select v-model="act.type" class="cond-type">
                  <option value="regex_replace">{{ t('rewrites.actionRegexReplace') }}</option>
                  <option value="text_replace">{{ t('rewrites.actionTextReplace') }}</option>
                  <option value="prepend">{{ t('rewrites.actionPrepend') }}</option>
                  <option value="append">{{ t('rewrites.actionAppend') }}</option>
                  <option value="remove_tool">{{ t('rewrites.actionRemoveTool') }}</option>
                </select>
              </label>
              <label>
                {{ t('rewrites.actionScope') }}
                <select v-model="act.scope" class="cond-scope">
                  <option :value="undefined">{{ t('rewrites.actionScopeFollow') }}</option>
                  <option value="all">{{ t('rewrites.scopeAll') }}</option>
                  <option value="system">{{ t('rewrites.scopeSystem') }}</option>
                  <option value="user">{{ t('rewrites.scopeUser') }}</option>
                  <option value="assistant">{{ t('rewrites.scopeAssistant') }}</option>
                </select>
              </label>
            </div>

            <!-- remove_tool：工具匹配配置 -->
            <template v-if="act.type === 'remove_tool'">
              <div class="condition-row">
                <label>
                  {{ t('rewrites.toolFieldLabel') }}
                  <select v-model="act.toolField" class="cond-type">
                    <option value="name">{{ t('rewrites.toolFieldName') }}</option>
                    <option value="description">{{ t('rewrites.toolFieldDescription') }}</option>
                    <option value="input_schema">{{ t('rewrites.toolFieldSchema') }}</option>
                  </select>
                </label>
                <label>
                  {{ t('rewrites.matchModeLabel') }}
                  <select v-model="act.toolMatchMode" class="cond-type">
                    <option value="exact">{{ t('rewrites.modeExact') }}</option>
                    <option value="contains">{{ t('rewrites.modeContains') }}</option>
                    <option value="regex">{{ t('rewrites.modeRegex') }}</option>
                  </select>
                </label>
              </div>
              <div class="condition-row" style="align-items: flex-start">
                <label style="flex: 1">
                  {{ t('rewrites.toolPatternLabel') }}
                  <input
                    v-model="act.pattern"
                    :placeholder="act.toolMatchMode === 'exact' ? t('rewrites.toolExactPlaceholder') : act.toolMatchMode === 'contains' ? t('rewrites.toolContainsPlaceholder') : t('rewrites.toolRegexPlaceholder')"
                    class="cond-pattern"
                  />
                </label>
                <button v-if="i === form.actions.length - 1" class="btn-sm" type="button" @click="openToolPicker">{{ t('rewrites.pickFromLog') }}</button>
              </div>
              <p class="action-hint">{{ t('rewrites.removeToolHint') }}</p>
            </template>

            <!-- 替换类动作的查找内容 -->
            <div v-else-if="act.type === 'regex_replace' || act.type === 'text_replace'" class="condition-row" style="align-items: flex-start">
              <label style="flex: 1">
                {{ act.type === 'text_replace' ? t('rewrites.actionFindText') : t('rewrites.actionFindRegex') }}
                <textarea v-model="act.pattern" :placeholder="act.type === 'text_replace' ? t('rewrites.actionFindTextPlaceholder') : t('rewrites.actionFindRegexPlaceholder')" class="find-textarea" rows="2"></textarea>
              </label>
            </div>

            <!-- 正则 flags -->
            <div v-if="act.type === 'regex_replace' && act.pattern" class="condition-row">
              <label>
                {{ t('rewrites.actionFlags') }}
                <input v-model="act.flags" :placeholder="t('rewrites.actionFlagsPlaceholder')" class="cond-flags" />
              </label>
            </div>

            <!-- 替换/注入内容 -->
            <div v-if="act.type !== 'remove_tool'" class="condition-row" style="align-items: flex-start">
              <label style="flex: 1">
                {{ t('rewrites.replacement') }}
                <textarea v-model="act.replacement" :placeholder="t('rewrites.replacementPlaceholder')" class="replacement-textarea" rows="3"></textarea>
              </label>
            </div>
            <p v-if="act.type === 'regex_replace' || act.type === 'text_replace'" class="action-hint">{{ t('rewrites.emptyReplacementHint') }}</p>
          </div>

          <div style="margin-left: 24px; display: flex; gap: 8px">
            <button class="btn-sm" type="button" @click="addAction">{{ t('rewrites.addAction') }}</button>
            <button class="btn-sm" type="button" @click="openToolPicker">{{ t('rewrites.pickToolsFromLog') }}</button>
          </div>

          <!-- 从日志勾选工具弹层 -->
          <div v-if="showToolPicker" class="log-selector tool-picker">
            <template v-if="!pickedLogTools.length">
              <div class="log-selector-header">
                <strong>{{ t('rewrites.pickToolsFromLog') }}</strong>
                <span class="selected-count">{{ t('rewrites.chooseLogFirst') }}</span>
              </div>
              <div class="log-selector-list">
                <label v-for="log in toolPickerLogs" :key="log.id" class="log-item" @click.prevent="loadLogTools(log.id)">
                  <span class="log-model">{{ log.model }}</span>
                  <span class="log-time">{{ formatTime(log.timestamp) }}</span>
                  <span class="log-path">{{ log.path }}</span>
                  <span :class="['log-status', log.statusCode >= 400 ? 'error' : 'ok']">{{ log.statusCode }}</span>
                </label>
                <div v-if="!toolPickerLogs.length" class="empty">{{ t('rewrites.noContent') }}</div>
              </div>
            </template>
            <template v-else>
              <div class="log-selector-header">
                <input v-model="toolSearch" :placeholder="t('rewrites.toolSearchPlaceholder')" class="cond-pattern tool-search" />
                <button class="btn-sm" @click="pickedLogTools = []">{{ t('rewrites.backToLogs') }}</button>
              </div>
              <div class="log-selector-list">
                <label v-for="tool in filteredLogTools" :key="tool.name" class="log-item tool-item" :class="{ selected: checkedToolNames.has(tool.name) }">
                  <input type="checkbox" :checked="checkedToolNames.has(tool.name)" @change="toggleToolChecked(tool.name)" />
                  <span class="tool-name">{{ tool.name }}</span>
                  <span class="tool-desc">{{ tool.description.slice(0, 80) }}{{ tool.description.length > 80 ? '...' : '' }}</span>
                </label>
                <div v-if="!filteredLogTools.length" class="empty">{{ t('rewrites.noToolsInLog') }}</div>
              </div>
              <div class="log-selector-actions">
                <button class="btn-sm btn-primary-sm" :disabled="!checkedToolNames.size" @click="confirmAddRemoveActions">
                  {{ t('rewrites.addRemoveActions', { n: checkedToolNames.size }) }}
                </button>
                <button class="btn-sm" @click="showToolPicker = false">{{ t('rewrites.cancel') }}</button>
              </div>
            </template>
          </div>
        </div>

        <!-- 预览区 -->
        <div class="match-section">
          <div class="section-label">{{ t('rewrites.previewLabel') }}</div>
          <p class="section-hint">{{ t('rewrites.selectLogsHint') }}</p>

          <button class="btn-sm" type="button" @click="openLogSelector">{{ t('rewrites.selectLogs') }}</button>

          <!-- 日志选择弹层 -->
          <div v-if="showLogSelector" class="log-selector">
            <div class="log-selector-header">
              <strong>{{ t('rewrites.recentLogs') }}</strong>
              <span class="selected-count">{{ selectedLogIds.size }}/10</span>
            </div>
            <div class="log-selector-list">
              <label v-for="log in recentLogs" :key="log.id" class="log-item" :class="{ selected: selectedLogIds.has(log.id) }">
                <input type="checkbox" :checked="selectedLogIds.has(log.id)" @change="toggleLogSelect(log.id)" />
                <span class="log-model">{{ log.model }}</span>
                <span class="log-time">{{ formatTime(log.timestamp) }}</span>
                <span class="log-path">{{ log.path }}</span>
                <span :class="['log-status', log.statusCode >= 400 ? 'error' : 'ok']">{{ log.statusCode }}</span>
              </label>
              <div v-if="!recentLogs.length" class="empty">{{ t('rewrites.noContent') }}</div>
            </div>
            <div class="log-selector-actions">
              <button class="btn-sm" :disabled="!selectedLogIds.size || previewLoading" @click="executePreview">
                {{ previewLoading ? '...' : t('rewrites.executePreview') }}
              </button>
              <button class="btn-sm" @click="showLogSelector = false">{{ t('rewrites.cancel') }}</button>
            </div>
          </div>

          <!-- 预览结果 -->
          <div v-if="previewResults.length" class="preview-results">
            <div v-for="pv in previewViews" :key="pv.item.logId" class="preview-item">
              <div class="preview-header">
                <span class="preview-model">{{ pv.item.model }}</span>
                <span class="preview-path">{{ pv.item.path }}</span>
                <span v-if="previewLoading" class="preview-refreshing">...</span>
                <span :class="['preview-badge', pv.item.matched ? 'matched' : 'not-matched']">
                  {{ pv.item.matched ? t('rewrites.matched') : t('rewrites.notMatched') }}
                </span>
              </div>
              <div v-if="pv.item.matched && pv.item.matchedRules.length" class="preview-matched-rules">
                {{ pv.item.matchedRules.join(", ") }}
              </div>

              <!-- 改动快速导航：点击跳到对应 diff 区块 -->
              <div v-if="pv.changedStepViews.length" class="step-nav">
                <button
                  v-for="csv in pv.changedStepViews"
                  :key="csv.index"
                  class="step-nav-chip"
                  :title="csv.step.actionName || csv.step.ruleName"
                  @click="jumpToChange(pv.item.logId, csv.index)"
                >
                  #{{ csv.index + 1 }}{{ csv.step.actionName ? ` ${csv.step.actionName}` : ` ${csv.step.ruleName}` }}
                  <span class="chip-add">+{{ csv.addChars }}</span>
                  <span class="chip-del">-{{ csv.delChars }}</span>
                </button>
              </div>

              <!-- 按动作逐步展示 diff -->
              <div v-for="sv in pv.stepViews" :id="`preview-step-${pv.item.logId}-${sv.index}`" :key="sv.index" class="step-block" :class="{ changed: sv.changed }">
                <div class="step-header">
                  <span class="step-rule-name">#{{ sv.index + 1 }} {{ sv.step.ruleName }}</span>
                  <span v-if="sv.step.actionName" class="step-action-name">{{ sv.step.actionName }}</span>
                  <template v-if="sv.changed">
                    <span class="chip-add">+{{ sv.addChars }}</span>
                    <span class="chip-del">-{{ sv.delChars }}</span>
                  </template>
                  <span v-else class="step-no-change">{{ t('rewrites.stepNoChange') }}</span>
                </div>
                <div v-if="sv.changed" class="step-diff">
                  <span v-for="(span, spi) in sv.spans" :key="spi" :class="'dw-' + span.type">{{ span.text }}</span>
                </div>
              </div>

              <div v-if="!pv.item.matched && pv.item.original" class="preview-no-content">{{ t('rewrites.notMatched') }}</div>
              <div v-else-if="!pv.item.original" class="preview-no-content">{{ t('rewrites.noContent') }}</div>
            </div>
          </div>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" @click="save" :disabled="saving">{{ saving ? '...' : t('rewrites.save') }}</button>
          <button class="btn" @click="cancel">{{ t('rewrites.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/** 复用 RouteRules 的基础样式 */
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

.form-card .btn-sm:disabled {
  opacity: 0.5;
  cursor: default;
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

.cond-scope {
  width: 110px;
  min-width: 110px;
  padding: 6px 10px;
  background: var(--bg);
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

.section-hint {
  font-size: 12px;
  color: var(--text-dim);
  margin: -8px 0 12px;
  opacity: 0.7;
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

.scope-tags {
  margin-top: 2px;
  font-size: 12px;
}

/** 动作标签 */
.action-tag {
  display: inline-block;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  margin-right: 6px;
  font-weight: 600;
}

.action-tag.action-regex_replace { background: var(--tag-blue-bg); color: var(--tag-blue); }
.action-tag.action-text_replace { background: var(--tag-blue-bg); color: var(--tag-blue); }
.action-tag.action-prepend { background: var(--tag-green-bg); color: var(--tag-green); }
.action-tag.action-append { background: var(--tag-purple-bg); color: var(--tag-purple); }

.action-detail {
  font-size: 12px;
  color: var(--text-dim);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: middle;
}

/** 规则列表中的动作行 */
.action-line {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
}

/** 动作组编辑器 */
.action-editor {
  padding: 10px 12px;
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}

.action-editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.action-index {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

/** 替换内容输入框 */
.replacement-textarea {
  width: 100%;
  min-height: 60px;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
  font-family: monospace;
  resize: vertical;
  transition: border-color 0.15s;
}

.replacement-textarea:focus {
  outline: none;
  border-color: var(--primary);
}

/** 日志选择器 */
.log-selector {
  margin-top: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  max-height: 400px;
  display: flex;
  flex-direction: column;
}

.log-selector-header {
  padding: 8px 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.selected-count {
  font-size: 12px;
  color: var(--primary);
  font-weight: 600;
}

.log-selector-list {
  overflow-y: auto;
  max-height: 260px;
  padding: 4px 0;
}

.log-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.1s;
}

.log-item:hover {
  background: var(--surface);
}

.log-item.selected {
  background: var(--surface2);
}

.log-item input[type="checkbox"] {
  margin: 0;
  width: 14px;
  height: 14px;
  accent-color: var(--primary);
}

.log-model {
  font-weight: 600;
  min-width: 80px;
}

.log-time {
  color: var(--text-dim);
  flex: 1;
}

.log-path {
  color: var(--text-dim);
  font-family: monospace;
  font-size: 11px;
}

.log-status {
  font-weight: 600;
  font-size: 11px;
}

.log-status.ok { color: var(--tag-green); }
.log-status.error { color: var(--tag-red); }

.log-selector-actions {
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

/** 从日志勾选工具 */
.tool-picker {
  margin-left: 24px;
  width: calc(100% - 24px);
}

.tool-search {
  flex: 1;
}

.tool-picker .btn-primary-sm {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

.tool-name {
  font-weight: 600;
  font-family: monospace;
  font-size: 11px;
  min-width: 180px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-desc {
  color: var(--text-dim);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/** 预览结果 */
.preview-results {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.preview-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.preview-header {
  padding: 8px 12px;
  background: var(--surface);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.preview-model {
  font-weight: 600;
}

.preview-path {
  color: var(--text-dim);
  font-family: monospace;
  font-size: 11px;
}

.preview-badge {
  margin-left: auto;
  padding: 1px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.preview-badge.matched {
  background: var(--tag-green-bg);
  color: var(--tag-green);
}

.preview-badge.not-matched {
  background: var(--surface2);
  color: var(--text-dim);
}

.preview-matched-rules {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--primary);
  background: var(--surface);
}

.preview-diff {
  padding: 8px 12px;
  font-family: monospace;
  font-size: 12px;
  max-height: 300px;
  overflow-y: auto;
  line-height: 1.6;
}

.diff-line {
  white-space: pre-wrap;
  word-break: break-all;
}

.diff-line.changed {
  background: rgba(239, 68, 68, 0.05);
}

.diff-orig {
  color: var(--tag-red);
}

.diff-new {
  color: var(--tag-green);
}

.diff-marker {
  display: inline-block;
  width: 14px;
  font-weight: 600;
}

.diff-unchanged {
  color: var(--text-dim);
}

/** 按规则分步的 diff 展示 */
.step-block {
  border-top: 1px solid var(--border);
}

.step-block.changed {
  border-left: 3px solid var(--primary);
}

.step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--surface);
  font-size: 12px;
  flex-wrap: wrap;
}

.step-rule-name {
  font-weight: 600;
  color: var(--primary);
}

.step-action-name {
  font-size: 11px;
  color: var(--text-dim);
  background: var(--surface2);
  padding: 1px 8px;
  border-radius: 4px;
}

.step-no-change {
  font-size: 11px;
  color: var(--text-dim);
}

/** 改动快速导航 */
.step-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.step-nav-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  cursor: pointer;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: all 0.15s;
}

.step-nav-chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}

.chip-add {
  color: var(--tag-green);
  font-weight: 600;
  font-size: 10px;
}

.chip-del {
  color: var(--tag-red);
  font-weight: 600;
  font-size: 10px;
}

.preview-refreshing {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
}

/** 查找内容输入框（textarea 版） */
.find-textarea {
  width: 100%;
  min-height: 44px;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
  font-family: monospace;
  resize: vertical;
  transition: border-color 0.15s;
}

.find-textarea:focus {
  outline: none;
  border-color: var(--primary);
}

.action-hint {
  margin: -2px 0 8px;
  font-size: 11px;
  color: var(--text-dim);
  opacity: 0.8;
}

.action-name {
  font-size: 11px;
  color: var(--text-dim);
}

.step-diff {
  padding: 8px 12px;
  font-family: monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 260px;
  overflow-y: auto;
}

.step-diff .dw-same {
  color: var(--text-dim);
}

.step-diff .dw-del {
  background: rgba(239, 68, 68, 0.15);
  color: var(--tag-red);
  text-decoration: line-through;
  border-radius: 2px;
}

.step-diff .dw-add {
  background: rgba(34, 197, 94, 0.15);
  color: var(--tag-green);
  border-radius: 2px;
  font-weight: 600;
}

.preview-no-content {
  padding: 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
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
  .cond-type, .cond-scope {
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
}
</style>

<script setup lang="ts">
import { ref, onMounted } from "vue"
import { rewriteApi, logApi, type RewriteRuleInfo, type RewritePreviewItem, type LogEntry } from "../api"
import { t } from "../i18n"

const rules = ref<RewriteRuleInfo[]>([])
const loading = ref(true)
const creating = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const error = ref("")

const emptyRule: Omit<RewriteRuleInfo, "id" | "createdAt"> = {
  name: "",
  match: [],
  action: { type: "replace", replacement: "" },
  enabled: true,
  priority: 0,
}

const form = ref({ ...emptyRule, match: [], action: { type: "replace" as const, replacement: "" } })

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
    action: { type: "replace", replacement: "" },
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
    action: rule.action ? { ...rule.action } : { type: "replace", replacement: "" },
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
}

async function save() {
  const data = { ...form.value }
  if (!data.name) { error.value = t('rewrites.errorNameRequired'); return }
  if (!data.match?.length) { error.value = t('rewrites.errorMatchRequired'); return }
  if (!data.action) { error.value = t('rewrites.errorActionRequired'); return }
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
  const ids = [...selectedLogIds.value]
  if (!ids.length) return
  previewLoading.value = true
  try {
    /** 传入当前表单中的临时规则定义 */
    const resp = await rewriteApi.preview({
      rule: {
        name: form.value.name || "preview",
        match: form.value.match,
        action: form.value.action,
        enabled: true,
        priority: 0,
        modelPattern: form.value.modelPattern || undefined,
        pathPattern: form.value.pathPattern || undefined,
      },
      logIds: ids,
    })
    previewResults.value = resp.results
    showLogSelector.value = false
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Preview failed"
  }
  previewLoading.value = false
}

/** 动作标签文本 */
function actionTag(type: string): string {
  const map: Record<string, string> = {
    replace: t('rewrites.actionTagReplace'),
    replace_all: t('rewrites.actionTagReplaceAll'),
    prepend: t('rewrites.actionTagPrepend'),
    append: t('rewrites.actionTagAppend'),
  }
  return map[type] ?? type
}

/** 简单 diff 高亮：找出原文和替换后文本的差异部分 */
function diffLines(original: string, rewritten: string): { original: string; rewritten: string; changed: boolean }[] {
  const origLines = original.split("\n")
  const rewrLines = rewritten.split("\n")
  const maxLen = Math.max(origLines.length, rewrLines.length)
  const result: { original: string; rewritten: string; changed: boolean }[] = []
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i] ?? ""
    const r = rewrLines[i] ?? ""
    result.push({ original: o, rewritten: r, changed: o !== r })
  }
  return result
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

    <div v-else>
      <table class="table" v-if="!creating">
        <thead>
          <tr>
            <th>#</th>
            <th>{{ t('rewrites.ruleName') }}</th>
            <th>{{ t('rewrites.matchConditionLabel') }}</th>
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
              <span class="action-tag" :class="'action-' + rule.action.type">{{ actionTag(rule.action.type) }}</span>
              <span v-if="rule.action.type === 'replace' || rule.action.type === 'replace_all'" class="action-detail">
                "{{ rule.action.pattern || rule.match?.[0]?.pattern || '' }}" → "{{ rule.action.replacement }}"
              </span>
              <span v-else class="action-detail">"{{ rule.action.replacement.slice(0, 50) }}{{ rule.action.replacement.length > 50 ? '...' : '' }}"</span>
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

        <!-- 匹配条件 -->
        <div class="match-section">
          <div class="section-label">{{ t('rewrites.matchConditionLabel') }}</div>

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

        <!-- 执行动作 -->
        <div class="match-section">
          <div class="section-label">{{ t('rewrites.actionLabel') }}</div>

          <div class="condition-row">
            <label>
              {{ t('rewrites.actionType') }}
              <select v-model="form.action.type" class="cond-type">
                <option value="replace">{{ t('rewrites.actionReplace') }}</option>
                <option value="replace_all">{{ t('rewrites.actionReplaceAll') }}</option>
                <option value="prepend">{{ t('rewrites.actionPrepend') }}</option>
                <option value="append">{{ t('rewrites.actionAppend') }}</option>
              </select>
            </label>
          </div>

          <!-- 替换类动作的匹配模式 -->
          <div v-if="form.action.type === 'replace' || form.action.type === 'replace_all'" class="condition-row">
            <label>
              {{ t('rewrites.actionPattern') }}
              <input v-model="form.action.pattern" :placeholder="t('rewrites.actionPatternPlaceholder')" class="cond-pattern" />
            </label>
          </div>

          <!-- 正则 flags -->
          <div v-if="(form.action.type === 'replace' || form.action.type === 'replace_all') && form.action.pattern" class="condition-row">
            <label>
              {{ t('rewrites.actionFlags') }}
              <input v-model="form.action.flags" :placeholder="t('rewrites.actionFlagsPlaceholder')" class="cond-flags" />
            </label>
          </div>

          <!-- 替换/注入内容 -->
          <div class="condition-row" style="align-items: flex-start">
            <label style="flex: 1">
              {{ t('rewrites.replacement') }}
              <textarea v-model="form.action.replacement" :placeholder="t('rewrites.replacementPlaceholder')" class="replacement-textarea" rows="3"></textarea>
            </label>
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
            <div v-for="item in previewResults" :key="item.logId" class="preview-item">
              <div class="preview-header">
                <span class="preview-model">{{ item.model }}</span>
                <span class="preview-path">{{ item.path }}</span>
                <span :class="['preview-badge', item.matched ? 'matched' : 'not-matched']">
                  {{ item.matched ? t('rewrites.matched') : t('rewrites.notMatched') }}
                </span>
              </div>
              <div v-if="item.matched && item.matchedRules.length" class="preview-matched-rules">
                {{ item.matchedRules.join(", ") }}
              </div>
              <div v-if="item.original && item.rewritten" class="preview-diff">
                <div v-for="(line, li) in diffLines(item.original, item.rewritten)" :key="li" class="diff-line" :class="{ changed: line.changed }">
                  <template v-if="line.changed">
                    <div class="diff-orig"><span class="diff-marker">-</span>{{ line.original }}</div>
                    <div class="diff-new"><span class="diff-marker">+</span>{{ line.rewritten }}</div>
                  </template>
                  <template v-else>
                    <span class="diff-unchanged">{{ line.original }}</span>
                  </template>
                </div>
              </div>
              <div v-else-if="!item.original" class="preview-no-content">{{ t('rewrites.noContent') }}</div>
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

.action-tag.action-replace { background: var(--tag-blue-bg); color: var(--tag-blue); }
.action-tag.action-replace_all { background: var(--tag-blue-bg); color: var(--tag-blue); }
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

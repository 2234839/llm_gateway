<script setup lang="ts">
import { ref, computed, onMounted } from "vue"
import { routeApi, providerApi, type RouteRuleInfo, type ProviderInfo } from "../api"

const rules = ref<RouteRuleInfo[]>([])
const providers = ref<ProviderInfo[]>([])
const loading = ref(true)
const creating = ref(false)

const emptyRule: Omit<RouteRuleInfo, "id"> = {
  pattern: "",
  providerId: "",
  targetModel: "",
  modelMapping: {},
  priority: 0,
  contentMatch: [],
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
  creating.value = true
  form.value = { ...emptyRule, contentMatch: [] }
}

function cancel() {
  creating.value = false
}

async function save() {
  const data = { ...form.value }
  if (!data.contentMatch?.length) data.contentMatch = undefined
  if (!data.targetModel) data.targetModel = undefined
  if (!data.pattern) data.pattern = ""
  await routeApi.create(data)
  cancel()
  await load()
}

async function remove(id: string) {
  await routeApi.delete(id)
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
</script>

<template>
  <div class="route-rules">
    <div class="toolbar">
      <h2>路由规则</h2>
      <button class="btn btn-primary" @click="startCreate">+ 添加规则</button>
    </div>

    <div v-if="loading" class="loading">加载中...</div>

    <div v-else>
      <table class="table" v-if="!creating">
        <thead>
          <tr>
            <th>#</th>
            <th>匹配条件</th>
            <th>服务商</th>
            <th>目标模型</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(rule, idx) in rules" :key="rule.id">
            <td>
              <div class="priority-cell">
                <button class="btn-icon" :disabled="idx === 0" @click="moveUp(idx)" title="上移">&#9650;</button>
                <span class="priority-num">{{ idx + 1 }}</span>
                <button class="btn-icon" :disabled="idx === rules.length - 1" @click="moveDown(idx)" title="下移">&#9660;</button>
              </div>
            </td>
            <td>
              <span v-if="rule.pattern && rule.pattern !== '*'" class="match-tag model">模型: <code>{{ rule.pattern }}</code></span>
              <span v-for="(cond, ci) in rule.contentMatch" :key="ci" class="match-tag" :class="cond.type === 'content_type' ? 'media' : 'content'">
                <template v-if="cond.type === 'content_type'">
                  {{ cond.pattern === 'image' ? '包含图片' : cond.pattern === 'file' ? '包含文件' : cond.pattern === 'tool_use' ? '包含工具调用' : cond.pattern }}
                </template>
                <template v-else>
                  {{ cond.type === 'keyword' ? '包含' : '匹配' }} "{{ cond.pattern }}"
                </template>
              </span>
              <span v-if="(!rule.pattern || rule.pattern === '*') && !rule.contentMatch?.length" class="muted">匹配所有</span>
            </td>
            <td>{{ providerName(rule.providerId) }}</td>
            <td>
              <span v-if="rule.targetModel">{{ rule.targetModel }}</span>
              <span v-else class="muted">原始模型名</span>
            </td>
            <td>
              <button class="btn-sm btn-danger" @click="remove(rule.id)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="creating" class="form-card">
        <h3>添加路由规则</h3>

        <!-- 服务商 & 目标模型 -->
        <div class="form-grid">
          <label>
            服务商
            <select v-model="form.providerId">
              <option value="" disabled>选择服务商</option>
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </label>
          <label v-if="providerModels.length">
            目标模型
            <select v-model="form.targetModel">
              <option value="">使用原始模型名</option>
              <option v-for="m in providerModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
          <label v-else>
            目标模型
            <input v-model="form.targetModel" placeholder="不填则使用原始模型名" />
          </label>
        </div>

        <!-- 匹配条件 -->
        <div class="match-section">
          <div class="section-label">匹配条件（至少选一个）</div>

          <!-- 模型名匹配 -->
          <div class="condition-row">
            <label class="checkbox-label">
              <input type="checkbox" :checked="!!form.pattern" @change="form.pattern = ($event.target as HTMLInputElement).checked ? '*' : ''" />
              按模型名匹配
            </label>
            <input v-if="form.pattern" v-model="form.pattern" placeholder="gpt-*" class="cond-pattern" />
          </div>

          <!-- 内容匹配 -->
          <div class="condition-row">
            <label class="checkbox-label">
              <input type="checkbox" :checked="!!form.contentMatch?.length" @change="($event.target as HTMLInputElement).checked ? addCondition() : (form.contentMatch = undefined)" />
              按消息内容匹配
            </label>
          </div>

          <div v-if="form.contentMatch?.length" class="content-conditions">
            <div v-if="form.contentMatch.length > 1" class="operator-select">
              <select :value="form.contentMatch[0].operator ?? 'and'" @change="syncOperator()">
                <option value="and">全部匹配 (AND)</option>
                <option value="or">任一匹配 (OR)</option>
              </select>
            </div>

            <div v-for="(cond, i) in form.contentMatch" :key="i" class="condition-row indented">
              <select v-model="cond.type" class="cond-type">
                <option value="keyword">关键词</option>
                <option value="regex">正则表达式</option>
                <option value="content_type">内容类型</option>
              </select>
              <select
                v-if="cond.type === 'content_type'"
                v-model="cond.pattern"
                class="cond-pattern"
              >
                <option value="image">包含图片</option>
                <option value="file">包含文件</option>
                <option value="tool_use">包含工具调用</option>
              </select>
              <input
                v-else
                v-model="cond.pattern"
                :placeholder="cond.type === 'keyword' ? '输入关键词' : '输入正则表达式'"
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

            <button class="btn-sm" type="button" @click="addCondition" style="margin-left: 24px">+ 添加条件</button>
          </div>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" @click="save">保存</button>
          <button class="btn" @click="cancel">取消</button>
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
</style>

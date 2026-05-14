<script setup lang="ts">
import { ref, onMounted } from "vue"
import { providerApi, type ProviderInfo, type ProviderTestResult } from "../api"

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
}

const form = ref({ ...emptyProvider })

/** 测试连通性状态 */
const testing = ref(false)
const testResult = ref<ProviderTestResult | null>(null)

/** 模型输入框临时值 */
const modelInput = ref("")

onMounted(load)

async function load() {
  loading.value = true
  providers.value = await providerApi.list()
  loading.value = false
}

function startEdit(p: ProviderInfo) {
  editing.value = p
  form.value = { ...p }
  creating.value = false
  testResult.value = null
  modelInput.value = ""
}

function startCreate() {
  editing.value = null
  creating.value = true
  form.value = { ...emptyProvider }
  testResult.value = null
  modelInput.value = ""
}

function cancel() {
  editing.value = null
  creating.value = false
  testResult.value = null
  modelInput.value = ""
}

async function save() {
  if (creating.value) {
    await providerApi.create(form.value)
  } else if (editing.value) {
    await providerApi.update(editing.value.id, form.value)
  }
  cancel()
  await load()
}

async function remove(id: string) {
  await providerApi.delete(id)
  await load()
}

async function toggleEnabled(p: ProviderInfo) {
  await providerApi.update(p.id, { enabled: !p.enabled })
  await load()
}

async function testConnection() {
  testing.value = true
  testResult.value = null
  const data = creating.value || !editing.value
    ? { baseUrl: form.value.baseUrl, apiKey: form.value.apiKey, type: form.value.type, customHeaders: form.value.customHeaders }
    : { baseUrl: form.value.baseUrl, apiKey: form.value.apiKey, type: form.value.type, customHeaders: form.value.customHeaders }
  testResult.value = await providerApi.test(data)
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
</script>

<template>
  <div class="provider-list">
    <div class="toolbar">
      <h2>服务商</h2>
      <button class="btn btn-primary" @click="startCreate">+ 添加服务商</button>
    </div>

    <div v-if="loading" class="loading">加载中...</div>

    <div v-else>
      <table class="table" v-if="!creating && !editing">
        <thead>
          <tr>
            <th>名称</th>
            <th>类型</th>
            <th>接口地址</th>
            <th>模型</th>
            <th>并发限制</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in providers" :key="p.id">
            <td>{{ p.name }}</td>
            <td><span class="badge">{{ p.type }}</span></td>
            <td class="mono">{{ p.baseUrl }}</td>
            <td>
              <span v-for="m in p.models" :key="m" class="model-tag">{{ m }}</span>
            </td>
            <td>{{ p.maxConcurrency || '不限' }}</td>
            <td>
              <button :class="['toggle-btn', { on: p.enabled }]" @click="toggleEnabled(p)">
                {{ p.enabled ? "启用" : "禁用" }}
              </button>
            </td>
            <td>
              <button class="btn-sm" @click="startEdit(p)">编辑</button>
              <button class="btn-sm btn-danger" @click="remove(p.id)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="creating || editing" class="form-card">
        <h3>{{ creating ? "添加服务商" : "编辑服务商" }}</h3>
        <div class="form-grid">
          <label>
            名称
            <input v-model="form.name" placeholder="我的服务商" />
          </label>
          <label>
            类型
            <select v-model="form.type">
              <option v-for="opt in typeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
          </label>
          <label class="span-2">
            接口地址
            <input v-model="form.baseUrl" placeholder="https://api.openai.com/v1" class="mono" />
          </label>
          <label class="span-2">
            API 密钥
            <input v-model="form.apiKey" type="password" placeholder="sk-..." />
          </label>
          <label class="span-2">
            模型
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
                  placeholder="输入模型名称"
                  @keydown.enter.prevent="addModel"
                />
                <button class="btn-sm" type="button" @click="addModel">+</button>
              </div>
            </div>
          </label>
          <label>
            并发限制
            <input v-model.number="form.maxConcurrency" type="number" min="0" placeholder="0 = 不限制" />
          </label>
          <label>
            启用
            <input type="checkbox" v-model="form.enabled" />
          </label>
        </div>

        <div v-if="testResult" :class="['test-result', { success: testResult.success, fail: !testResult.success }]">
          {{ testResult.success
            ? `连接成功 (${testResult.statusCode}) - ${testResult.duration}ms`
            : `连接失败 (${testResult.statusCode}) - ${testResult.error ?? '未知错误'}` }}
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" @click="save">保存</button>
          <button class="btn" :disabled="testing" @click="testConnection">
            {{ testing ? "测试中..." : "测试连接" }}
          </button>
          <button class="btn" @click="cancel">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
  background: #e6f9e6;
  color: #1a7a1a;
  border: 1px solid #b2dfb2;
}

.test-result.fail {
  background: #fde8e8;
  color: #c41e1e;
  border: 1px solid #f5b3b3;
}
</style>

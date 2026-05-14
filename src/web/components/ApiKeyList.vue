<script setup lang="ts">
import { ref, onMounted } from "vue"
import { apiKeyApi, keyGroupApi, type KeyGroupInfo, type ApiKeyInfo } from "../api"
import { t } from "../i18n"

/** ========== Key Groups ========== */

const groups = ref<KeyGroupInfo[]>([])
const keys = ref<ApiKeyInfo[]>([])
const loading = ref(false)
const error = ref("")

/** 分组表单状态 */
const groupEditing = ref<KeyGroupInfo | null>(null)
const groupCreating = ref(false)

const emptyGroup: Omit<KeyGroupInfo, "id" | "createdAt" | "keyCount"> = {
  name: "",
  description: "",
  dailyTokenLimit: 0,
  monthlyTokenLimit: 0,
  rpmLimit: 0,
}

const groupForm = ref({ ...emptyGroup })

/** ========== API Keys ========== */

const keyEditing = ref<ApiKeyInfo | null>(null)
const keyCreating = ref(false)

const emptyKey = {
  name: "",
  groupId: "",
  dailyTokenLimit: 0,
  monthlyTokenLimit: 0,
  rpmLimit: 0,
  description: "",
}

const keyForm = ref({ ...emptyKey })

/** 新建密钥后展示原始密钥 */
const createdKeySecret = ref<string | null>(null)

onMounted(load)

async function load() {
  try {
    loading.value = true
    error.value = ""
    const [g, k] = await Promise.all([keyGroupApi.list(), apiKeyApi.list()])
    groups.value = g
    keys.value = k
  } catch (e: any) {
    error.value = e.message || "Failed to load"
  } finally {
    loading.value = false
  }
}

/** ========== Key Group CRUD ========== */

function startCreateGroup() {
  groupEditing.value = null
  groupCreating.value = true
  groupForm.value = { ...emptyGroup }
}

function startEditGroup(g: KeyGroupInfo) {
  groupEditing.value = g
  groupCreating.value = false
  groupForm.value = {
    name: g.name,
    description: g.description,
    dailyTokenLimit: g.dailyTokenLimit,
    monthlyTokenLimit: g.monthlyTokenLimit,
    rpmLimit: g.rpmLimit,
  }
}

function cancelGroup() {
  groupEditing.value = null
  groupCreating.value = false
}

async function saveGroup() {
  try {
    error.value = ""
    if (groupCreating.value) {
      await keyGroupApi.create(groupForm.value)
    } else if (groupEditing.value) {
      await keyGroupApi.update(groupEditing.value.id, groupForm.value)
    }
    cancelGroup()
    await load()
  } catch (e: any) {
    error.value = e.message || "Operation failed"
  }
}

async function removeGroup(id: string) {
  const group = groups.value.find(g => g.id === id)
  if (!confirm(t('keys.deleteGroupConfirm', { name: group?.name ?? "" }))) return
  try {
    error.value = ""
    await keyGroupApi.delete(id)
    await load()
  } catch (e: any) {
    error.value = e.message || "Operation failed"
  }
}

/** ========== API Key CRUD ========== */

function startCreateKey() {
  keyEditing.value = null
  keyCreating.value = true
  /** 默认选中第一个分组 */
  const defaultGroupId = groups.value.length > 0 ? groups.value[0].id : ""
  keyForm.value = { ...emptyKey, groupId: defaultGroupId }
}

function startEditKey(k: ApiKeyInfo) {
  keyEditing.value = k
  keyCreating.value = false
  keyForm.value = {
    name: k.name,
    groupId: k.groupId,
    dailyTokenLimit: k.dailyTokenLimit,
    monthlyTokenLimit: k.monthlyTokenLimit,
    rpmLimit: k.rpmLimit,
    description: k.description,
  }
}

function cancelKey() {
  keyEditing.value = null
  keyCreating.value = false
}

async function saveKey() {
  try {
    error.value = ""
    if (keyCreating.value) {
      const result = await apiKeyApi.create(keyForm.value)
      /** 创建后展示原始密钥 */
      createdKeySecret.value = (result as ApiKeyInfo & { rawKey: string }).rawKey
      cancelKey()
      await load()
    } else if (keyEditing.value) {
      await apiKeyApi.update(keyEditing.value.id, {
        name: keyForm.value.name,
        groupId: keyForm.value.groupId,
        dailyTokenLimit: keyForm.value.dailyTokenLimit,
        monthlyTokenLimit: keyForm.value.monthlyTokenLimit,
        rpmLimit: keyForm.value.rpmLimit,
        description: keyForm.value.description,
      })
      cancelKey()
      await load()
    }
  } catch (e: any) {
    error.value = e.message || "Operation failed"
  }
}

async function removeKey(id: string) {
  const key = keys.value.find(k => k.id === id)
  if (!confirm(t('keys.deleteKeyConfirm', { name: key?.name ?? "" }))) return
  try {
    error.value = ""
    await apiKeyApi.delete(id)
    await load()
  } catch (e: any) {
    error.value = e.message || "Operation failed"
  }
}

async function toggleKeyEnabled(k: ApiKeyInfo) {
  try {
    error.value = ""
    await apiKeyApi.update(k.id, { enabled: !k.enabled })
    await load()
  } catch (e: any) {
    error.value = e.message || "Operation failed"
  }
}

function closeSecretModal() {
  createdKeySecret.value = null
}

async function copySecret() {
  if (!createdKeySecret.value) return
  try {
    error.value = ""
    await navigator.clipboard.writeText(createdKeySecret.value)
  } catch (e: any) {
    error.value = e.message || "Operation failed"
  }
}

/** ========== Helpers ========== */

/** 根据分组 ID 查找分组名称 */
function groupName(groupId: string): string {
  return groups.value.find(g => g.id === groupId)?.name ?? groupId
}

/** 格式化限额显示 */
function formatLimit(val: number): string {
  return val > 0 ? val.toLocaleString() : t("keys.unlimited")
}

/** 格式化时间 */
function formatTime(iso: string | null): string {
  if (!iso) return "-"
  const d = new Date(iso)
  return d.toLocaleString()
}
</script>

<template>
  <div class="apikey-list">
    <div v-if="error" class="error-banner">{{ error }}</div>
    <div v-if="loading" class="loading">{{ t("keys.loading") }}</div>

    <template v-else>
      <!-- ========== Section 1: Key Groups ========== -->
      <section class="section">
        <div class="toolbar">
          <h2>{{ t("keys.groupTitle") }}</h2>
          <button class="btn btn-primary" @click="startCreateGroup">{{ t("keys.addGroup") }}</button>
        </div>

        <table class="table" v-if="!groupCreating && !groupEditing">
          <thead>
            <tr>
              <th>{{ t("keys.nameCol") }}</th>
              <th>{{ t("keys.descCol") }}</th>
              <th>{{ t("keys.dailyLimitCol") }}</th>
              <th>{{ t("keys.monthlyLimitCol") }}</th>
              <th>{{ t("keys.rpmLimitCol") }}</th>
              <th>{{ t("keys.keyCountCol") }}</th>
              <th>{{ t("keys.actionsCol") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="groups.length === 0">
              <td colspan="7" class="muted">{{ t("keys.noGroups") }}</td>
            </tr>
            <tr v-for="g in groups" :key="g.id">
              <td>{{ g.name }}</td>
              <td>{{ g.description || "-" }}</td>
              <td>{{ formatLimit(g.dailyTokenLimit) }}</td>
              <td>{{ formatLimit(g.monthlyTokenLimit) }}</td>
              <td>{{ formatLimit(g.rpmLimit) }}</td>
              <td>{{ g.keyCount }}</td>
              <td>
                <div class="actions-cell">
                  <button class="btn-sm" @click="startEditGroup(g)">{{ t("keys.edit") }}</button>
                  <button class="btn-sm btn-danger" @click="removeGroup(g.id)">{{ t("keys.delete") }}</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="groupCreating || groupEditing" class="form-card">
          <h3>{{ groupCreating ? t("keys.addGroupTitle") : t("keys.editGroupTitle") }}</h3>
          <div class="form-grid">
            <label>
              {{ t("keys.nameLabel") }}
              <input v-model="groupForm.name" :placeholder="t('keys.namePlaceholder')" />
            </label>
            <label>
              {{ t("keys.descLabel") }}
              <input v-model="groupForm.description" :placeholder="t('keys.descPlaceholder')" />
            </label>
            <label>
              {{ t("keys.dailyLimitLabel") }}
              <input v-model.number="groupForm.dailyTokenLimit" type="number" min="0" :placeholder="t('keys.limitPlaceholder')" />
            </label>
            <label>
              {{ t("keys.monthlyLimitLabel") }}
              <input v-model.number="groupForm.monthlyTokenLimit" type="number" min="0" :placeholder="t('keys.limitPlaceholder')" />
            </label>
            <label>
              {{ t("keys.rpmLimitLabel") }}
              <input v-model.number="groupForm.rpmLimit" type="number" min="0" :placeholder="t('keys.limitPlaceholder')" />
            </label>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" @click="saveGroup">{{ t("keys.save") }}</button>
            <button class="btn" @click="cancelGroup">{{ t("keys.cancel") }}</button>
          </div>
        </div>
      </section>

      <!-- ========== Section 2: API Keys ========== -->
      <section class="section">
        <div class="toolbar">
          <h2>{{ t("keys.keyTitle") }}</h2>
          <button class="btn btn-primary" :disabled="groups.length === 0" @click="startCreateKey">{{ t("keys.addKey") }}</button>
        </div>

        <table class="table" v-if="!keyCreating && !keyEditing">
          <thead>
            <tr>
              <th>{{ t("keys.nameCol") }}</th>
              <th>{{ t("keys.prefixCol") }}</th>
              <th>{{ t("keys.groupCol") }}</th>
              <th>{{ t("keys.statusCol") }}</th>
              <th>{{ t("keys.dailyLimitCol") }}</th>
              <th>{{ t("keys.lastUsedCol") }}</th>
              <th>{{ t("keys.createdAtCol") }}</th>
              <th>{{ t("keys.actionsCol") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="keys.length === 0">
              <td colspan="8" class="muted">{{ t("keys.noKeys") }}</td>
            </tr>
            <tr v-for="k in keys" :key="k.id" :class="{ disabled: !k.enabled }">
              <td>{{ k.name }}</td>
              <td><code class="mono">{{ k.keyPrefix }}</code></td>
              <td>{{ groupName(k.groupId) }}</td>
              <td>
                <label class="toggle" :title="k.enabled ? t('keys.enabled') : t('keys.disabled')">
                  <input type="checkbox" :checked="k.enabled" @change="toggleKeyEnabled(k)" />
                  <span class="toggle-slider"></span>
                </label>
              </td>
              <td>{{ formatLimit(k.dailyTokenLimit) }}</td>
              <td>{{ formatTime(k.lastUsedAt) }}</td>
              <td>{{ formatTime(k.createdAt) }}</td>
              <td>
                <div class="actions-cell">
                  <button class="btn-sm" @click="startEditKey(k)">{{ t("keys.edit") }}</button>
                  <button class="btn-sm btn-danger" @click="removeKey(k.id)">{{ t("keys.delete") }}</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <div v-if="keyCreating || keyEditing" class="form-card">
          <h3>{{ keyCreating ? t("keys.addKeyTitle") : t("keys.editKeyTitle") }}</h3>
          <div class="form-grid">
            <label>
              {{ t("keys.nameLabel") }}
              <input v-model="keyForm.name" :placeholder="t('keys.keyNamePlaceholder')" />
            </label>
            <label>
              {{ t("keys.groupCol") }}
              <select v-model="keyForm.groupId">
                <option value="" disabled>{{ t("keys.selectGroup") }}</option>
                <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
              </select>
            </label>
            <label>
              {{ t("keys.dailyLimitLabel") }}
              <input v-model.number="keyForm.dailyTokenLimit" type="number" min="0" :placeholder="t('keys.keyLimitPlaceholder')" />
            </label>
            <label>
              {{ t("keys.monthlyLimitLabel") }}
              <input v-model.number="keyForm.monthlyTokenLimit" type="number" min="0" :placeholder="t('keys.keyLimitPlaceholder')" />
            </label>
            <label>
              {{ t("keys.rpmLimitLabel") }}
              <input v-model.number="keyForm.rpmLimit" type="number" min="0" :placeholder="t('keys.keyLimitPlaceholder')" />
            </label>
            <label class="span-2">
              {{ t("keys.descLabel") }}
              <input v-model="keyForm.description" :placeholder="t('keys.descPlaceholder')" />
            </label>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" @click="saveKey">{{ t("keys.save") }}</button>
            <button class="btn" @click="cancelKey">{{ t("keys.cancel") }}</button>
          </div>
        </div>
      </section>

      <!-- ========== Secret Modal ========== -->
      <div v-if="createdKeySecret" class="modal-overlay" @click.self="closeSecretModal">
        <div class="modal-card">
          <h3>{{ t("keys.keyCreatedTitle") }}</h3>
          <p class="warning-text">{{ t("keys.keyCreatedWarning") }}</p>
          <div class="secret-row">
            <input :value="createdKeySecret" readonly class="mono secret-input" @focus="($event.target as HTMLInputElement).select()" />
            <button class="btn btn-primary" @click="copySecret">{{ t("keys.copy") }}</button>
          </div>
          <div class="form-actions">
            <button class="btn" @click="closeSecretModal">{{ t("keys.close") }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.section {
  margin-bottom: 32px;
}

.section:last-child {
  margin-bottom: 0;
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

/** Secret modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.modal-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 24px;
  width: 560px;
  max-width: 90vw;
}

.warning-text {
  color: var(--test-fail);
  font-size: 14px;
  margin: 8px 0 16px;
}

.secret-row {
  display: flex;
  gap: 8px;
}

.secret-input {
  flex: 1;
  font-size: 13px;
}

.error-banner {
  background: var(--err);
  color: white;
  padding: 8px 12px;
  border-radius: 4px;
  margin-bottom: 12px;
}
</style>

<script setup lang="ts">
import { ref, onMounted } from "vue"
import { secretApi, type SecretInfo } from "../api"
import { t } from "../i18n"

const secrets = ref<SecretInfo[]>([])
const loading = ref(true)
const creating = ref(false)
const editingId = ref<string | null>(null)
const saving = ref(false)
const error = ref("")

/** 新建表单（placeholder 留空 = 后端自动生成） */
const form = ref<{ name: string; placeholder: string; value: string; enabled: boolean }>({ name: "", placeholder: "", value: "", enabled: true })
/** 真实值显示/隐藏 */
const revealedIds = ref<Set<string>>(new Set())

onMounted(load)

async function load() {
  loading.value = true
  error.value = ""
  try {
    secrets.value = await secretApi.list()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Failed to load"
  }
  loading.value = false
}

function startCreate() {
  editingId.value = null
  creating.value = true
  form.value = { name: "", placeholder: "", value: "", enabled: true }
}

function startEdit(s: SecretInfo) {
  editingId.value = s.id
  creating.value = true
  form.value = { name: s.name, placeholder: s.placeholder, value: s.value, enabled: s.enabled }
}

function cancel() {
  editingId.value = null
  creating.value = false
}

async function save() {
  if (!form.value.name) { error.value = t('vault.errorNameRequired'); return }
  if (!form.value.value) { error.value = t('vault.errorValueRequired'); return }
  error.value = ""
  saving.value = true
  try {
    const data = {
      name: form.value.name,
      value: form.value.value,
      enabled: form.value.enabled,
      /** 占位符留空 = 后端自动生成；编辑时未改动则不传 */
      ...(form.value.placeholder.trim() ? { placeholder: form.value.placeholder.trim() } : {}),
    }
    if (editingId.value) {
      await secretApi.update(editingId.value, data)
    } else {
      await secretApi.create(data)
    }
    cancel()
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Save failed"
  }
  saving.value = false
}

async function remove(id: string) {
  if (!confirm(t('vault.confirmDelete'))) return
  error.value = ""
  try {
    await secretApi.delete(id)
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Delete failed"
  }
}

async function toggleEnabled(s: SecretInfo) {
  error.value = ""
  try {
    await secretApi.update(s.id, { enabled: !s.enabled })
    await load()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : "Update failed"
  }
}

/** 复制占位符到剪贴板（在提示词/工具描述中直接引用它） */
async function copyPlaceholder(placeholder: string) {
  try {
    await navigator.clipboard.writeText(placeholder)
  } catch { /* clipboard 不可用时静默 */ }
}

function toggleReveal(id: string) {
  const next = new Set(revealedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  revealedIds.value = next
}

/** 真实值显示：已 reveal 的原样，否则打码 */
function maskValue(s: SecretInfo): string {
  if (revealedIds.value.has(s.id)) return s.value
  if (!s.value) return ""
  return s.value.slice(0, 3) + "•".repeat(Math.min(20, Math.max(6, s.value.length - 3)))
}
</script>

<template>
  <div class="secret-vault">
    <div class="toolbar">
      <h2>{{ t('vault.title') }}</h2>
      <button class="btn btn-primary" @click="startCreate">{{ t('vault.addSecret') }}</button>
    </div>

    <div v-if="loading" class="loading">Loading...</div>
    <p v-if="error" class="error-text">{{ error }}</p>

    <div v-if="!loading && !creating" class="vault-hint">{{ t('vault.hint') }}</div>

    <div v-if="!loading">
      <table class="table" v-if="!creating">
        <thead>
          <tr>
            <th>{{ t('vault.nameCol') }}</th>
            <th>{{ t('vault.placeholderCol') }}</th>
            <th>{{ t('vault.valueCol') }}</th>
            <th>{{ t('vault.statusCol') }}</th>
            <th>{{ t('vault.actionsCol') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in secrets" :key="s.id" :class="{ disabled: !s.enabled }">
            <td><strong>{{ s.name }}</strong></td>
            <td>
              <code class="placeholder-chip" @click="copyPlaceholder(s.placeholder)" :title="t('vault.copyPlaceholder')">{{ s.placeholder }}</code>
            </td>
            <td>
              <code class="value-text">{{ maskValue(s) }}</code>
              <button class="btn-sm" @click="toggleReveal(s.id)">{{ revealedIds.has(s.id) ? t('vault.hide') : t('vault.show') }}</button>
            </td>
            <td>
              <label class="toggle" :title="s.enabled ? t('vault.enabled') : t('vault.disabled')">
                <input type="checkbox" :checked="s.enabled" @change="toggleEnabled(s)" />
                <span class="toggle-slider"></span>
              </label>
            </td>
            <td>
              <div class="actions-cell">
                <button class="btn-sm" @click="startEdit(s)">{{ t('vault.edit') }}</button>
                <button class="btn-sm btn-danger" @click="remove(s.id)">{{ t('vault.delete') }}</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="secrets.length === 0 && !creating" class="empty">{{ t('vault.noSecrets') }}</div>

      <!-- 新建/编辑表单 -->
      <div v-if="creating" class="form-card">
        <h3>{{ editingId ? t('vault.editTitle') : t('vault.addTitle') }}</h3>
        <div class="form-grid">
          <label>
            <span>{{ t('vault.nameLabel') }}</span>
            <input v-model="form.name" :placeholder="t('vault.namePlaceholder')" />
          </label>
          <label>
            <span>{{ t('vault.placeholderLabel') }}</span>
            <input v-model="form.placeholder" :placeholder="t('vault.placeholderPlaceholder')" :disabled="!!editingId" />
          </label>
          <label class="form-row-full">
            <span>{{ t('vault.valueLabel') }}</span>
            <input v-model="form.value" type="text" :placeholder="t('vault.valuePlaceholder')" autocomplete="off" spellcheck="false" />
          </label>
          <label class="toggle-row form-row-full">
            <span>{{ t('vault.enabledLabel') }}</span>
            <label class="toggle">
              <input type="checkbox" v-model="form.enabled" />
              <span class="toggle-slider"></span>
            </label>
          </label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? t('vault.saving') : t('vault.save') }}</button>
          <button class="btn" @click="cancel">{{ t('vault.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.secret-vault {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.vault-hint {
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-soft, rgba(0, 0, 0, 0.03));
  font-size: 13px;
  color: var(--text-secondary, #666);
  line-height: 1.6;
}

.placeholder-chip {
  font-family: monospace;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-soft, rgba(0, 0, 0, 0.05));
  cursor: pointer;
  user-select: all;
}

.value-text {
  font-family: monospace;
  font-size: 12px;
  word-break: break-all;
  margin-right: 8px;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.form-row-full {
  grid-column: 1 / -1;
}

.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.form-grid input {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg, #fff);
  color: var(--text, #222);
  font-family: monospace;
}

.toggle-row {
  flex-direction: row !important;
  align-items: center;
  gap: 10px !important;
}

.form-actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}

.actions-cell {
  display: flex;
  gap: 6px;
  align-items: center;
}

.empty {
  padding: 32px;
  text-align: center;
  color: var(--text-secondary, #888);
}
</style>

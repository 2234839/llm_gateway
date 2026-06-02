<script setup lang="ts">
import { type ConditionNode, type ConditionLeaf, type ConditionGroup } from "../api"
import { t } from "../i18n"

const props = defineProps<{
  /** 条件树根节点 */
  modelValue?: ConditionNode
  /** 是否为排除条件模式（排除条件不显示 model 类型） */
  excludeMode?: boolean
}>()

const emit = defineEmits<{
  "update:modelValue": [value: ConditionNode | undefined]
}>()

/** 确保根节点存在，默认 AND 组 */
function ensureRoot(): ConditionGroup {
  if (props.modelValue && (props.modelValue.type === "and" || props.modelValue.type === "or")) {
    return props.modelValue as ConditionGroup
  }
  /** 如果当前是叶子，包装成 AND 组 */
  const group: ConditionGroup = { type: "and", children: props.modelValue ? [props.modelValue] : [] }
  emit("update:modelValue", group)
  return group
}

/** 切换逻辑运算符 */
function toggleLogic(group: ConditionGroup) {
  group.type = group.type === "and" ? "or" : "and"
  emitUpdate(group)
}

/** 添加叶子条件 */
function addLeaf(group: ConditionGroup) {
  group.children.push({ type: "keyword", pattern: "" })
  emitUpdate(group)
}

/** 添加子逻辑组 */
function addSubGroup(group: ConditionGroup) {
  group.children.push({ type: "and", children: [{ type: "keyword", pattern: "" }] })
  emitUpdate(group)
}

/** 删除子节点 */
function removeChild(group: ConditionGroup, index: number) {
  group.children.splice(index, 1)
  if (group.children.length === 0) {
    emit("update:modelValue", undefined)
  } else {
    emitUpdate(group)
  }
}

/** 更新子节点（从 ConditionTree 子组件的 emit 触发） */
function updateChild(group: ConditionGroup, index: number, value: ConditionNode) {
  group.children[index] = value
  emitUpdate(group)
}

/** 触发更新 */
function emitUpdate(node: ConditionNode) {
  emit("update:modelValue", node)
}

/** 判断节点是否为逻辑组 */
function isGroup(node: ConditionNode): node is ConditionGroup {
  return node.type === "and" || node.type === "or"
}

/** 解析 char_count pattern 为操作符和数值 */
function parseCharCount(pattern: string): { op: string; value: number } {
  const m = pattern.match(/^(<=?|>=?)(\d+)$/)
  return m ? { op: m[1], value: parseInt(m[2], 10) } : { op: "<", value: 0 }
}

/** 从操作符和数值合成 char_count pattern */
function buildCharCountPattern(op: string, value: number): string {
  return `${op}${value}`
}

/** 叶子类型选项（排除模式下不含 model） */
const leafTypes = computed(() => {
  const types = [
    { value: "model", label: t("route.model") },
    { value: "keyword", label: t("route.keyword") },
    { value: "regex", label: t("route.regex") },
    { value: "content_type", label: t("route.contentType") },
    { value: "char_count", label: t("route.charCount") },
  ]
  if (props.excludeMode) return types.filter(tp => tp.value !== "model")
  return types
})
</script>

<template>
  <div v-if="modelValue" class="condition-tree">
    <!-- 根节点是叶子（单条件，无逻辑组包装） -->
    <template v-if="!isGroup(modelValue)">
      <div class="leaf-row">
        <select :value="modelValue.type" @change="(modelValue as ConditionLeaf).type = ($event.target as HTMLSelectElement).value as ConditionLeaf['type']; emitUpdate(modelValue)" class="cond-type">
          <option v-for="tp in leafTypes" :key="tp.value" :value="tp.value">{{ tp.label }}</option>
        </select>
        <!-- char_count -->
        <template v-if="modelValue.type === 'char_count'">
          <select
            :value="parseCharCount((modelValue as ConditionLeaf).pattern).op"
            @change="(modelValue as ConditionLeaf).pattern = buildCharCountPattern(($event.target as HTMLSelectElement).value, parseCharCount((modelValue as ConditionLeaf).pattern).value); emitUpdate(modelValue)"
            class="cond-op"
          >
            <option value="<">{{ t('route.charCountLt') }}</option>
            <option value="<=">{{ t('route.charCountLte') }}</option>
            <option value=">">{{ t('route.charCountGt') }}</option>
            <option value=">=">{{ t('route.charCountGte') }}</option>
          </select>
          <input
            type="number"
            :value="parseCharCount((modelValue as ConditionLeaf).pattern).value || ''"
            @input="(modelValue as ConditionLeaf).pattern = buildCharCountPattern(parseCharCount((modelValue as ConditionLeaf).pattern).op, parseInt(($event.target as HTMLInputElement).value) || 0); emitUpdate(modelValue)"
            :placeholder="t('route.charCountPlaceholder')"
            class="cond-pattern"
          />
        </template>
        <!-- content_type -->
        <select
          v-else-if="modelValue.type === 'content_type'"
          v-model="(modelValue as ConditionLeaf).pattern"
          @change="emitUpdate(modelValue)"
          class="cond-pattern"
        >
          <option value="image">{{ t('route.containsImage') }}</option>
          <option value="file">{{ t('route.containsFile') }}</option>
          <option value="tool_use">{{ t('route.containsToolUse') }}</option>
        </select>
        <!-- model/keyword/regex -->
        <input
          v-else
          v-model="(modelValue as ConditionLeaf).pattern"
          @input="emitUpdate(modelValue)"
          :placeholder="(modelValue as ConditionLeaf).type === 'model' ? 'gpt-*' : (modelValue as ConditionLeaf).type === 'keyword' ? t('route.keywordPlaceholder') : t('route.regexPlaceholder')"
          class="cond-pattern"
        />
        <input
          v-if="modelValue.type === 'regex'"
          v-model="(modelValue as ConditionLeaf).flags"
          @input="emitUpdate(modelValue)"
          placeholder="flags"
          class="cond-flags"
        />
        <button class="btn-sm btn-danger" type="button" @click="emit('update:modelValue', undefined)">&times;</button>
      </div>
    </template>

    <!-- 根节点是逻辑组 -->
    <template v-else>
      <div class="logic-group">
        <div class="group-header">
          <button class="btn-logic" :class="modelValue.type" @click="toggleLogic(modelValue as ConditionGroup)" type="button">
            {{ modelValue.type === 'and' ? t('route.matchAllAnd') : t('route.matchAnyOr') }}
          </button>
          <div class="group-actions">
            <button class="btn-sm" type="button" @click="addLeaf(modelValue as ConditionGroup)">{{ t('route.addCondition') }}</button>
            <button class="btn-sm" type="button" @click="addSubGroup(modelValue as ConditionGroup)">{{ t('route.addGroup') }}</button>
          </div>
        </div>
        <div class="group-children">
          <div v-for="(child, i) in (modelValue as ConditionGroup).children" :key="i" class="child-wrapper">
            <!-- 子节点是逻辑组：递归渲染 -->
            <ConditionTree
              v-if="isGroup(child)"
              :modelValue="child"
              :excludeMode="excludeMode"
              @update:modelValue="(v: ConditionNode) => updateChild(modelValue as ConditionGroup, i, v)"
            />
            <!-- 子节点是叶子 -->
            <template v-else>
              <div class="leaf-row">
                <select :value="child.type" @change="(child as ConditionLeaf).type = ($event.target as HTMLSelectElement).value as ConditionLeaf['type']; emitUpdate(modelValue!)" class="cond-type">
                  <option v-for="tp in leafTypes" :key="tp.value" :value="tp.value">{{ tp.label }}</option>
                </select>
                <!-- char_count -->
                <template v-if="child.type === 'char_count'">
                  <select
                    :value="parseCharCount((child as ConditionLeaf).pattern).op"
                    @change="(child as ConditionLeaf).pattern = buildCharCountPattern(($event.target as HTMLSelectElement).value, parseCharCount((child as ConditionLeaf).pattern).value); emitUpdate(modelValue!)"
                    class="cond-op"
                  >
                    <option value="<">{{ t('route.charCountLt') }}</option>
                    <option value="<=">{{ t('route.charCountLte') }}</option>
                    <option value=">">{{ t('route.charCountGt') }}</option>
                    <option value=">=">{{ t('route.charCountGte') }}</option>
                  </select>
                  <input
                    type="number"
                    :value="parseCharCount((child as ConditionLeaf).pattern).value || ''"
                    @input="(child as ConditionLeaf).pattern = buildCharCountPattern(parseCharCount((child as ConditionLeaf).pattern).op, parseInt(($event.target as HTMLInputElement).value) || 0); emitUpdate(modelValue!)"
                    :placeholder="t('route.charCountPlaceholder')"
                    class="cond-pattern"
                  />
                </template>
                <!-- content_type -->
                <select
                  v-else-if="child.type === 'content_type'"
                  v-model="(child as ConditionLeaf).pattern"
                  @change="emitUpdate(modelValue!)"
                  class="cond-pattern"
                >
                  <option value="image">{{ t('route.containsImage') }}</option>
                  <option value="file">{{ t('route.containsFile') }}</option>
                  <option value="tool_use">{{ t('route.containsToolUse') }}</option>
                </select>
                <!-- model/keyword/regex -->
                <input
                  v-else
                  v-model="(child as ConditionLeaf).pattern"
                  @input="emitUpdate(modelValue!)"
                  :placeholder="(child as ConditionLeaf).type === 'model' ? 'gpt-*' : (child as ConditionLeaf).type === 'keyword' ? t('route.keywordPlaceholder') : t('route.regexPlaceholder')"
                  class="cond-pattern"
                />
                <input
                  v-if="child.type === 'regex'"
                  v-model="(child as ConditionLeaf).flags"
                  @input="emitUpdate(modelValue!)"
                  placeholder="flags"
                  class="cond-flags"
                />
                <button class="btn-sm btn-danger" type="button" @click="removeChild(modelValue as ConditionGroup, i)">&times;</button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>

  <!-- 无条件时显示添加按钮 -->
  <div v-else class="condition-tree">
    <button class="btn-sm" type="button" @click="emit('update:modelValue', { type: 'and', children: [{ type: 'keyword', pattern: '' }] })">{{ t('route.addMatchCondition') }}</button>
  </div>
</template>

<script lang="ts">
import { computed } from "vue"
export default { name: "ConditionTree" }
</script>

<style scoped>
.condition-tree {
  margin-top: 4px;
}

.logic-group {
  border-left: 3px solid var(--primary);
  padding-left: 12px;
  margin-bottom: 8px;
}

.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.group-actions {
  display: flex;
  gap: 4px;
}

.btn-logic {
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s;
}

.btn-logic.and {
  background: var(--tag-blue-bg);
  color: var(--tag-blue);
  border-color: var(--tag-blue);
}

.btn-logic.or {
  background: var(--tag-purple-bg);
  color: var(--tag-purple);
  border-color: var(--tag-purple);
}

.btn-logic:hover {
  opacity: 0.85;
}

.group-children {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.child-wrapper {
  position: relative;
}

.leaf-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.cond-type {
  width: 140px;
  min-width: 140px;
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 24px;
}

.cond-pattern {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
}

.cond-pattern:focus {
  outline: none;
  border-color: var(--primary);
}

.cond-flags {
  width: 80px;
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
}

.cond-op {
  width: 120px;
  min-width: 120px;
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 24px;
}

.btn-sm {
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

.btn-sm:hover {
  background: var(--surface2);
  color: var(--text);
}

.btn-sm.btn-danger {
  color: var(--danger);
  border-color: transparent;
  background: transparent;
  padding: 5px 8px;
  font-size: 16px;
  line-height: 1;
}

.btn-sm.btn-danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

@media (max-width: 768px) {
  .leaf-row {
    flex-wrap: wrap;
    gap: 6px;
  }
  .cond-type {
    width: 100%;
    min-width: 0;
  }
  .cond-op {
    width: 100%;
    min-width: 0;
  }
  .cond-pattern {
    min-width: 0;
  }
  .logic-group {
    padding-left: 8px;
  }
}
</style>

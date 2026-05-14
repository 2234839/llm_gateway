<script setup lang="ts">
import { ref, onMounted } from "vue"
import Dashboard from "./components/Dashboard.vue"
import ProviderList from "./components/ProviderList.vue"
import RouteRules from "./components/RouteRules.vue"
import RequestLog from "./components/RequestLog.vue"

const activeTab = ref("dashboard")

const tabs = [
  { key: "dashboard", label: "仪表盘" },
  { key: "providers", label: "服务商" },
  { key: "routes", label: "路由规则" },
  { key: "logs", label: "请求日志" },
]

const isDark = ref(true)

function initTheme() {
  const saved = localStorage.getItem("theme")
  if (saved === "light") {
    isDark.value = false
  } else if (saved === "dark") {
    isDark.value = true
  } else {
    isDark.value = !window.matchMedia("(prefers-color-scheme: light)").matches
  }
  applyTheme()
}

function toggleTheme() {
  isDark.value = !isDark.value
  localStorage.setItem("theme", isDark.value ? "dark" : "light")
  applyTheme()
}

function applyTheme() {
  document.documentElement.dataset.theme = isDark.value ? "dark" : "light"
}

onMounted(initTheme)
</script>

<template>
  <div class="app">
    <header class="header">
      <h1 class="logo">LLM Gateway</h1>
      <nav class="nav">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          :class="['nav-btn', { active: activeTab === tab.key }]"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </nav>
      <div class="header-actions">
        <button class="theme-btn" @click="toggleTheme" :title="isDark ? '切换到亮色模式' : '切换到暗色模式'">
          {{ isDark ? "&#9788;" : "&#9790;" }}
        </button>
      </div>
    </header>

    <main class="main">
      <Dashboard v-if="activeTab === 'dashboard'" />
      <ProviderList v-else-if="activeTab === 'providers'" />
      <RouteRules v-else-if="activeTab === 'routes'" />
      <RequestLog v-else-if="activeTab === 'logs'" />
    </main>
  </div>
</template>

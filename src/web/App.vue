<script setup lang="ts">
import { ref, onMounted } from "vue"
import Dashboard from "./components/Dashboard.vue"
import ProviderList from "./components/ProviderList.vue"
import RouteRules from "./components/RouteRules.vue"
import RequestLog from "./components/RequestLog.vue"
import { t, currentLocale, setLocale } from "./i18n"

const activeTab = ref("dashboard")

function tabLabel(key: string): string {
  return t(`app.${key}`)
}

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

function toggleLocale() {
  setLocale(currentLocale.value === "zh" ? "en" : "zh")
}

const tabKeys = ["dashboard", "providers", "routes", "logs"]

onMounted(() => {
  initTheme()
  document.documentElement.lang = currentLocale.value === "zh" ? "zh-CN" : "en"
})
</script>

<template>
  <div class="app">
    <header class="header">
      <h1 class="logo">LLM Gateway</h1>
      <nav class="nav">
        <button
          v-for="key in tabKeys"
          :key="key"
          :class="['nav-btn', { active: activeTab === key }]"
          @click="activeTab = key"
        >
          {{ tabLabel(key) }}
        </button>
      </nav>
      <div class="header-actions">
        <button class="locale-btn" @click="toggleLocale">
          {{ currentLocale === 'zh' ? 'EN' : '中' }}
        </button>
        <button class="theme-btn" @click="toggleTheme" :title="isDark ? t('app.switchToLight') : t('app.switchToDark')">
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

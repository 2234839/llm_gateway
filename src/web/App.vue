<script setup lang="ts">
import { ref, reactive, watch, onMounted, onBeforeUnmount } from "vue"
import Dashboard from "./components/Dashboard.vue"
import ProviderList from "./components/ProviderList.vue"
import RouteRules from "./components/RouteRules.vue"
import ApiKeyList from "./components/ApiKeyList.vue"
import RequestLog from "./components/RequestLog.vue"
import { t, currentLocale, setLocale } from "./i18n"
import { initApi, configApi, authApi, ApiAuthError } from "./api"
import type { GatewayConfigInfo } from "./api"

/** 应用状态：loading -> init | login | main */
type AppState = "loading" | "init" | "login" | "main"
const appState = ref<AppState>("loading")

const initForm = reactive({ username: "", password: "", confirmPassword: "" })
const initError = ref("")

const loginForm = reactive({ username: "", password: "" })
const loginError = ref("")

const gatewayConfig = ref<GatewayConfigInfo | null>(null)

const activeTab = ref("dashboard")
const isDark = ref(true)
const showSettings = ref(false)

const LS_KEY_LOGGED_IN = "admin_logged_in"
const LS_KEY_CREDENTIALS = "admin_credentials"
const rememberMe = ref(false)

/** 进入登录页时恢复记住的凭据 */
watch(appState, (state) => {
  if (state === "login") {
    const saved = localStorage.getItem(LS_KEY_CREDENTIALS)
    if (saved) {
      try {
        const { username, password } = JSON.parse(saved)
        loginForm.username = username ?? ""
        loginForm.password = password ?? ""
        rememberMe.value = true
      } catch { /* ignore */ }
    }
  }
})

function setLoggedIn() {
  localStorage.setItem(LS_KEY_LOGGED_IN, "1")
}

function clearLoggedIn() {
  localStorage.removeItem(LS_KEY_LOGGED_IN)
}

function tabLabel(key: string): string {
  return t(`app.${key}`)
}

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

const tabKeys = ["dashboard", "providers", "routes", "keys", "logs"]

/** 启动时判断状态 */
onMounted(async () => {
  initTheme()
  document.documentElement.lang = currentLocale.value === "zh" ? "zh-CN" : "en"
  document.addEventListener("click", handleDocumentClick)

  /** 先读 localStorage 缓存，有则乐观显示主界面 */
  const cachedLoggedIn = localStorage.getItem(LS_KEY_LOGGED_IN) === "1"
  if (cachedLoggedIn) {
    appState.value = "main"
  }

  try {
    const result = await initApi.check()
    if (!result.initialized) {
      appState.value = "init"
      clearLoggedIn()
      return
    }
    /** 已初始化，尝试获取配置（验证 session 是否有效） */
    try {
      gatewayConfig.value = await configApi.get()
      setLoggedIn()
      appState.value = "main"
    } catch {
      clearLoggedIn()
      appState.value = "login"
    }
  } catch {
    /** initApi.check() 失败（如网络错误），尝试 configApi.get 验证 session */
    try {
      gatewayConfig.value = await configApi.get()
      setLoggedIn()
      appState.value = "main"
    } catch {
      clearLoggedIn()
      appState.value = "login"
    }
  }
})

onBeforeUnmount(() => {
  document.removeEventListener("click", handleDocumentClick)
})

/** 点击外部关闭设置面板 */
function handleDocumentClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.closest(".settings-btn") && !target.closest(".settings-panel")) {
    showSettings.value = false
  }
}

/** 初始化管理员 */
async function handleInit() {
  if (!initForm.username || !initForm.password) {
    initError.value = t("init.errorUsernamePassword")
    return
  }
  if (initForm.password !== initForm.confirmPassword) {
    initError.value = t("init.errorPasswordMismatch")
    return
  }
  if (initForm.password.length < 4) {
    initError.value = t("init.errorPasswordLength")
    return
  }
  try {
    /** init API 内部已自动创建 session cookie，无需再调 login */
    await initApi.init({ username: initForm.username, password: initForm.password })
    /** init 成功后尝试获取配置，失败则直接进入登录页（session cookie 已设置，刷新即可） */
    try {
      gatewayConfig.value = await configApi.get()
    } catch {
      /** 网络抖动，init 实际已成功，跳转登录页让用户刷新即可 */
      appState.value = "login"
      return
    }
    setLoggedIn()
    appState.value = "main"
  } catch (e: unknown) {
    initError.value = e instanceof Error ? e.message : t("init.errorFailed")
  }
}

/** 登录 */
async function handleLogin() {
  if (!loginForm.username || !loginForm.password) {
    loginError.value = t("login.errorUsernamePassword")
    return
  }
  try {
    await authApi.login({ username: loginForm.username, password: loginForm.password })
    gatewayConfig.value = await configApi.get()
    /** 记住帐号 */
    if (rememberMe.value) {
      localStorage.setItem(LS_KEY_CREDENTIALS, JSON.stringify({ username: loginForm.username, password: loginForm.password }))
    } else {
      localStorage.removeItem(LS_KEY_CREDENTIALS)
    }
    setLoggedIn()
    appState.value = "main"
  } catch (e: unknown) {
    if (e instanceof ApiAuthError) {
      loginError.value = t("login.errorInvalidCredentials")
    } else {
      loginError.value = e instanceof Error ? e.message : t("login.errorFailed")
    }
  }
}

/** 登出 */
async function handleLogout() {
  try {
    await authApi.logout()
  } catch { /* ignore */ }
  clearLoggedIn()
  gatewayConfig.value = null
  loginForm.username = ""
  loginForm.password = ""
  loginError.value = ""
  appState.value = "login"
}

async function toggleAuthRequired() {
  if (!gatewayConfig.value) return
  const newValue = !gatewayConfig.value.authRequired
  await configApi.update({ authRequired: newValue })
  gatewayConfig.value.authRequired = newValue
}
</script>

<template>
  <!-- 加载中 -->
  <div v-if="appState === 'loading'" class="init-screen">
    <div class="loading">{{ t("init.loading") }}</div>
  </div>

  <!-- 未初始化：初始化管理员 -->
  <div v-else-if="appState === 'init'" class="init-screen">
    <div class="init-card form-card">
      <h2>{{ t("init.title") }}</h2>
      <p class="init-desc">{{ t("init.subtitle") }}</p>
      <div class="init-form-grid">
        <label>
          <span>{{ t("init.username") }}</span>
          <input v-model="initForm.username" type="text" placeholder="admin" @keyup.enter="handleInit" />
        </label>
        <label>
          <span>{{ t("init.password") }}</span>
          <input v-model="initForm.password" type="password" :placeholder="t('init.errorPasswordLength')" @keyup.enter="handleInit" />
        </label>
        <label>
          <span>{{ t("init.confirmPassword") }}</span>
          <input v-model="initForm.confirmPassword" type="password" :placeholder="t('init.confirmPasswordPlaceholder')" @keyup.enter="handleInit" />
        </label>
      </div>
      <p v-if="initError" class="error-text">{{ initError }}</p>
      <div class="form-actions">
        <button class="btn btn-primary" @click="handleInit">{{ t("init.createButton") }}</button>
      </div>
    </div>
  </div>

  <!-- 登录页 -->
  <div v-else-if="appState === 'login'" class="init-screen">
    <div class="init-card form-card">
      <h2>LLM Gateway</h2>
      <p class="init-desc">{{ t("login.subtitle") }}</p>
      <div class="init-form-grid">
        <label>
          <span>{{ t("login.username") }}</span>
          <input v-model="loginForm.username" type="text" placeholder="admin" @keyup.enter="handleLogin" />
        </label>
        <label>
          <span>{{ t("login.password") }}</span>
          <input v-model="loginForm.password" type="password" @keyup.enter="handleLogin" />
        </label>
      </div>
      <label class="remember-row">
        <input type="checkbox" v-model="rememberMe" />
        <span>{{ t("login.rememberMe") }}</span>
      </label>
      <p v-if="loginError" class="error-text">{{ loginError }}</p>
      <div class="form-actions">
        <button class="btn btn-primary" @click="handleLogin">{{ t("login.submit") }}</button>
      </div>
    </div>
  </div>

  <!-- 主应用 -->
  <div v-else class="app">
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
        <div class="settings-wrapper">
          <button class="settings-btn" @click.stop="showSettings = !showSettings" :title="t('app.settings')">&#9881;</button>
          <div v-if="showSettings" class="settings-panel" @click.stop>
            <div class="settings-item">
              <span>{{ t('settings.requireAuth') }}</span>
              <label class="toggle">
                <input type="checkbox" :checked="gatewayConfig?.authRequired" @change="toggleAuthRequired">
                <span class="slider"></span>
              </label>
            </div>
            <div class="settings-item settings-hint">
              {{ t('settings.configFile') }}
            </div>
          </div>
        </div>
        <button class="locale-btn" @click="toggleLocale">
          {{ currentLocale === 'zh' ? 'EN' : '中' }}
        </button>
        <button class="theme-btn" @click="toggleTheme" :title="isDark ? t('app.switchToLight') : t('app.switchToDark')">
          {{ isDark ? "&#9788;" : "&#9790;" }}
        </button>
        <button class="logout-btn" @click="handleLogout" :title="t('login.logout')">{{ t('login.logout') }}</button>
      </div>
    </header>

    <main class="main">
      <Dashboard v-if="activeTab === 'dashboard'" />
      <ProviderList v-else-if="activeTab === 'providers'" />
      <RouteRules v-else-if="activeTab === 'routes'" />
      <ApiKeyList v-else-if="activeTab === 'keys'" />
      <RequestLog v-else-if="activeTab === 'logs'" />
    </main>
  </div>
</template>

<style scoped>
/* 初始化/登录屏幕 */
.init-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}

.init-card {
  width: 400px;
  max-width: 90vw;
}

.init-card h2 {
  margin-bottom: 8px;
  font-size: 20px;
}

.init-desc {
  color: var(--text-dim);
  font-size: 14px;
  margin-bottom: 20px;
}

.init-form-grid {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.init-form-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-dim);
}

.init-form-grid input {
  padding: 8px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
}

.init-form-grid input:focus {
  outline: none;
  border-color: var(--primary);
}

/* 记住用户名 */
.remember-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-dim);
  margin-top: 2px;
  cursor: pointer;
}

.remember-row input {
  margin: 0;
  cursor: pointer;
}

/* 退出按钮 */
.logout-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.15s;
}

.logout-btn:hover {
  color: var(--text);
  background: var(--surface);
}

/* 设置按钮和面板 */
.settings-wrapper {
  position: relative;
}

.settings-btn {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  transition: all 0.15s;
}

.settings-btn:hover {
  color: var(--text);
  background: var(--surface);
}

.settings-panel {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 16px;
  min-width: 260px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  z-index: 100;
}

.settings-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  padding: 6px 0;
}

.settings-hint {
  color: var(--text-dim);
  font-size: 11px;
  border-top: 1px solid var(--border);
  margin-top: 8px;
  padding-top: 10px;
  justify-content: flex-start;
}

/* Toggle 开关 */
.toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle .slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: var(--border);
  border-radius: 20px;
  transition: 0.2s;
}

.toggle .slider::before {
  content: "";
  position: absolute;
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background: var(--text-dim);
  border-radius: 50%;
  transition: 0.2s;
}

.toggle input:checked + .slider {
  background: var(--primary);
}

.toggle input:checked + .slider::before {
  transform: translateX(16px);
  background: #fff;
}
</style>

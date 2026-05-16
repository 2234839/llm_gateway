<script setup lang="ts">
import { ref, reactive, watch, onMounted, onBeforeUnmount } from "vue"
import Dashboard from "./components/Dashboard.vue"
import ProviderList from "./components/ProviderList.vue"
import RouteRules from "./components/RouteRules.vue"
import ApiKeyList from "./components/ApiKeyList.vue"
import RequestLog from "./components/RequestLog.vue"
import { t, currentLocale, setLocale } from "./i18n"
import { initApi, configApi, authApi, ApiAuthError, setOnAuthError } from "./api"
import type { GatewayConfigInfo, CorsConfigInfo } from "./api"

/** 应用状态：loading -> init | login | main */
type AppState = "loading" | "init" | "login" | "main"
const appState = ref<AppState>("loading")

const initForm = reactive({ username: "", password: "", confirmPassword: "" })
const initError = ref("")

const loginForm = reactive({ username: "", password: "" })
const loginError = ref("")

const gatewayConfig = ref<GatewayConfigInfo | null>(null)

/** 修改密码表单 */
const changePasswordMode = ref(false)
const changePasswordForm = reactive({ newPassword: "", confirmPassword: "" })
const changePasswordError = ref("")
const changePasswordSuccess = ref(false)

/** CORS 配置编辑状态 */
const corsEditMode = ref(false)
const corsForm = reactive<{
  originMode: "all" | "custom"
  origins: string
  methods: string
  allowedHeaders: string
}>({
  originMode: "all",
  origins: "",
  methods: "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  allowedHeaders: "Content-Type, Authorization, X-Requested-With",
})

const activeTab = ref("dashboard")
const appVersion = __APP_VERSION__
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
        const { username } = JSON.parse(saved)
        loginForm.username = username ?? ""
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

/** 同步 gatewayConfig.cors 到表单 */
watch(() => gatewayConfig.value?.cors, (cors) => {
  if (cors) {
    corsForm.originMode = cors.origin === true ? "all" : "custom"
    corsForm.origins = Array.isArray(cors.origin) ? cors.origin.join(", ") : ""
    corsForm.methods = cors.methods.join(", ")
    corsForm.allowedHeaders = cors.allowedHeaders.join(", ")
  }
}, { immediate: true })

async function handleSaveCors() {
  const cors: CorsConfigInfo = {
    origin: corsForm.originMode === "all" ? true : corsForm.origins.split(",").map(s => s.trim()).filter(Boolean),
    methods: corsForm.methods.split(",").map(s => s.trim()).filter(Boolean),
    allowedHeaders: corsForm.allowedHeaders.split(",").map(s => s.trim()).filter(Boolean),
  }
  if (Array.isArray(cors.origin) && cors.origin.length === 0) cors.origin = true
  await configApi.update({ gateway: { cors } })
  if (gatewayConfig.value) gatewayConfig.value.cors = cors
  corsEditMode.value = false
}

function toggleLocale() {
  setLocale(currentLocale.value === "zh" ? "en" : "zh")
}

const tabKeys = ["dashboard", "providers", "routes", "keys", "logs"]

/** 启动时判断状态 */
onMounted(async () => {
  setOnAuthError(() => {
    clearLoggedIn()
    appState.value = "login"
  })
  initTheme()
  document.documentElement.lang = currentLocale.value === "zh" ? "zh-CN" : "en"
  document.addEventListener("click", handleDocumentClick)
  document.addEventListener("keydown", handleDocumentKeydown)

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
  setOnAuthError(null)
  document.removeEventListener("click", handleDocumentClick)
  document.removeEventListener("keydown", handleDocumentKeydown)
})

/** 点击外部或按 Escape 关闭设置面板 */
function handleDocumentClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (!target.closest(".settings-btn") && !target.closest(".settings-panel")) {
    showSettings.value = false
  }
}

function handleDocumentKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && showSettings.value) {
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
      localStorage.setItem(LS_KEY_CREDENTIALS, JSON.stringify({ username: loginForm.username }))
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
  try {
    await configApi.update({ authRequired: newValue })
    gatewayConfig.value.authRequired = newValue
  } catch {
    /** 修改密码后 session 已失效，需要重新登录 */
    clearLoggedIn()
    appState.value = "login"
  }
}

async function handleChangePassword() {
  if (!changePasswordForm.newPassword) {
    changePasswordError.value = t("settings.errorPasswordRequired")
    return
  }
  if (changePasswordForm.newPassword !== changePasswordForm.confirmPassword) {
    changePasswordError.value = t("init.errorPasswordMismatch")
    return
  }
  try {
    changePasswordError.value = ""
    await configApi.update({ newPassword: changePasswordForm.newPassword })
    changePasswordSuccess.value = true
    changePasswordForm.newPassword = ""
    changePasswordForm.confirmPassword = ""
    setTimeout(() => {
      changePasswordSuccess.value = false
      changePasswordMode.value = false
    }, 2000)
  } catch (e: unknown) {
    changePasswordError.value = e instanceof Error ? e.message : "Failed"
  }
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
          <input v-model="initForm.password" type="password" :placeholder="t('init.passwordPlaceholder')" @keyup.enter="handleInit" />
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
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="settings-item">
              <span>{{ t('settings.corsTitle') }}</span>
              <button class="btn-sm" @click="corsEditMode = !corsEditMode">
                {{ corsEditMode ? t('provider.cancel') : t('settings.corsEditBtn') }}
              </button>
            </div>
            <div v-if="corsEditMode" class="settings-cors-form">
              <div class="cors-field">
                <label>{{ t('settings.corsOrigin') }}</label>
                <div class="cors-radio-group">
                  <label><input type="radio" v-model="corsForm.originMode" value="all" /> {{ t('settings.corsOriginAll') }}</label>
                  <label><input type="radio" v-model="corsForm.originMode" value="custom" /> {{ t('settings.corsOriginCustom') }}</label>
                </div>
                <input v-if="corsForm.originMode === 'custom'" v-model="corsForm.origins" :placeholder="t('settings.corsOriginPlaceholder')" />
              </div>
              <div class="cors-field">
                <label>{{ t('settings.corsMethods') }}</label>
                <input v-model="corsForm.methods" :placeholder="t('settings.corsMethodsPlaceholder')" />
              </div>
              <div class="cors-field">
                <label>{{ t('settings.corsHeaders') }}</label>
                <input v-model="corsForm.allowedHeaders" :placeholder="t('settings.corsHeadersPlaceholder')" />
              </div>
              <div class="cors-actions">
                <button class="btn-sm btn-primary" @click="handleSaveCors">{{ t('provider.save') }}</button>
              </div>
            </div>
            <div v-if="!changePasswordMode" class="settings-item">
              <span>{{ t('settings.changePassword') }}</span>
              <button class="btn-sm" @click="changePasswordMode = true; changePasswordSuccess = false">{{ t('settings.changeBtn') }}</button>
            </div>
            <div v-else class="settings-pw-form">
              <input v-model="changePasswordForm.newPassword" type="password" :placeholder="t('settings.newPassword')" />
              <input v-model="changePasswordForm.confirmPassword" type="password" :placeholder="t('settings.confirmNewPassword')" @keyup.enter="handleChangePassword" />
              <div class="settings-pw-actions">
                <button class="btn-sm btn-primary" @click="handleChangePassword">{{ t('provider.save') }}</button>
                <button class="btn-sm" @click="changePasswordMode = false; changePasswordError = ''">{{ t('provider.cancel') }}</button>
              </div>
              <p v-if="changePasswordError" class="error-text">{{ changePasswordError }}</p>
              <p v-if="changePasswordSuccess" class="success-text">{{ t('settings.passwordChanged') }}</p>
            </div>
            <div class="settings-item settings-hint">
              {{ t('settings.configFile') }}
            </div>
            <div class="settings-item settings-hint" style="border-top: none; margin-top: 0; padding-top: 4px;">
              {{ appVersion }}
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
      <KeepAlive :max="5">
        <Dashboard v-if="activeTab === 'dashboard'" />
        <ProviderList v-else-if="activeTab === 'providers'" />
        <RouteRules v-else-if="activeTab === 'routes'" />
        <ApiKeyList v-else-if="activeTab === 'keys'" />
        <RequestLog v-else-if="activeTab === 'logs'" />
      </KeepAlive>
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

.settings-pw-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 0;
}

.settings-pw-form input {
  padding: 6px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  font-size: 13px;
}

.settings-pw-form input:focus {
  outline: none;
  border-color: var(--primary);
}

.settings-pw-actions {
  display: flex;
  gap: 6px;
}

.success-text {
  color: var(--ok);
  font-size: 12px;
  margin-top: 2px;
}

.error-text {
  color: var(--err);
  font-size: 12px;
  margin-top: 2px;
}

.settings-cors-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--border);
  margin-top: 4px;
}

.cors-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cors-field > label {
  font-size: 11px;
  color: var(--text-dim);
}

.cors-radio-group {
  display: flex;
  gap: 12px;
  font-size: 12px;
}

.cors-radio-group label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.cors-field input[type="text"] {
  padding: 5px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 4px;
  font-size: 12px;
}

.cors-field input[type="text"]:focus {
  outline: none;
  border-color: var(--primary);
}

.cors-actions {
  display: flex;
  gap: 6px;
}


</style>

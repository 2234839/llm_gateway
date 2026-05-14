import { ref } from "vue"
import zh from "./zh"
import en from "./en"

/** 支持的语言列表 */
export const supportedLocales = ["zh", "en"] as const
export type Locale = (typeof supportedLocales)[number]

const messages: Record<Locale, Record<string, Record<string, string>>> = { zh, en }

/** 当前语言 */
export const currentLocale = ref<Locale>(initLocale())

function initLocale(): Locale {
  const saved = localStorage.getItem("locale")
  if (saved && supportedLocales.includes(saved as Locale)) return saved as Locale
  return "zh"
}

/** 切换语言 */
export function setLocale(locale: Locale) {
  currentLocale.value = locale
  localStorage.setItem("locale", locale)
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en"
}

/**
 * 翻译函数，支持插值 {key}
 * @example t('provider.testSuccess', { code: 200, ms: 150 })
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const parts = key.split(".")
  const section = parts[0] ?? ""
  const prop = parts[1] ?? ""
  const msg = messages[currentLocale.value]?.[section]?.[prop] ?? messages.zh?.[section]?.[prop] ?? key
  if (!params) return msg
  return msg.replace(/\{(\w+)\}/g, (_: string, k: string) => String(params[k] ?? `{${k}}`))
}

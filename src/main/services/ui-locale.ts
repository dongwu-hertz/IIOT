/**
 * 主进程侧的界面语言与告警弹窗文案（2026-09-23「弹窗内容显示的是目录键名」修复）。
 *
 * 背景：联动弹窗（`linkage-actions.ts` 的 `renderPopupHtml`）的标题与正文由组合根
 * 的 `text` 解析器产出。此前那个解析器只做了一件事——把**目录键名**、设备名、时刻
 * 拼成一行（`linkage.popup.warning · 相机 · 2026-09-23T…`），于是弹窗上显示的是
 * 一串键名而不是一句话。
 *
 * 这里修掉两半：
 *   1. 文案真的来自共享消息目录（`shared/i18n/messages/*`，主进程可直接 import）；
 *   2. 语言跟随界面：渲染层应用/切换语言时通过 `app.setLocale` 上报（见
 *      `useLocale.ts`），没上报过就用出厂默认 `zh-CN`。
 *
 * 这里只放**弹窗用得着的那几个键**的解析，不是把整套 vue-i18n 搬进主进程。
 */
import { zhCN } from '@shared/i18n/messages/zh-CN'
import { zhTW } from '@shared/i18n/messages/zh-TW'
import { en } from '@shared/i18n/messages/en'
import { es } from '@shared/i18n/messages/es'
import { tr } from '@shared/i18n/messages/tr'
import { ru } from '@shared/i18n/messages/ru'
import { LOCALES, type AppLocale } from '@shared/i18n/locales'

const CATALOGS: Record<AppLocale, typeof zhCN> = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, es, tr, ru }

/** 出厂默认语言（与渲染层 `useLocale` 的默认一致）。 */
const DEFAULT_LOCALE: AppLocale = 'zh-CN'

let currentLocale: AppLocale = DEFAULT_LOCALE

/** 渲染层上报当前界面语言（切换语言时也会再报一次）。 */
export function setUiLocale(locale: string): void {
  currentLocale = (LOCALES as readonly string[]).includes(locale) ? (locale as AppLocale) : DEFAULT_LOCALE
}

export function getUiLocale(): AppLocale {
  return currentLocale
}

/** 弹窗上的时刻：ISO 串换成 `YYYY-MM-DD HH:mm:ss`（设备时间，本地时区）。 */
export function formatPopupTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 解析一个联动弹窗文案键，并做 `{param}` 插值。
 *
 * 键不存在时**如实退化**为「键名 + 设备 + 时刻」的中性文本（与旧行为一致），
 * 而不是抛出——弹窗是告警链路的一环，文案缺失不能拦住告警本身。
 */
export function renderLinkagePopupText(key: string, params: Record<string, string>): string {
  const catalog = CATALOGS[currentLocale] as unknown as Record<string, unknown>
  const linkage = catalog['linkage'] as Record<string, unknown> | undefined
  const shortKey = key.startsWith('linkage.') ? key.slice('linkage.'.length) : key
  const template = linkage?.[shortKey]
  if (typeof template !== 'string' || template === '') {
    return [key, params.device, params.time].filter((part) => part && part !== '').join(' · ')
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}

/**
 * 相机实时画面的**画面偏好**：音量的取值规则与翻转的几何。
 *
 * WHY THE PURE HALF LIVES IN `shared/`
 * 与 `shared/domain/trend.ts` 里的通道配色同一条理由：单测跑在 `src/shared/**` + `tests/**`
 * 上，**编译不到 `src/renderer/**`**。放在渲染层就只能靠"读源码字符串"来断言，
 * 而"`NaN` 会不会被修好""90° 该配多少缩放"恰恰是能真的跑一遍才算验证过的东西。
 * 需要 `window.localStorage` 的那一半（读写）留在渲染层的 `lib/cameraLivePrefs.ts`。
 *
 * WHY THE VALUE IS REPAIRED RATHER THAN TRUSTED
 * localStorage 里的东西可以被上一次运行的旧版本、手工编辑、或者一次整数溢出的写入改坏。
 * 一个 `NaN` 音量会让 `<video>.volume = NaN` 抛 `IndexSizeError`，于是"画面起不来"而看不出
 * 原因。所以读进来的值一律过一遍 `sanitiseCameraVolume()`：坏的丢掉、回默认。
 */

/** 偏好键前缀，沿用 `hertzinno.`（见 `shared/i18n/locales.ts` 的既有约定）。 */
export const CAMERA_VOLUME_STORAGE_PREFIX = 'hertzinno.cameraLive.volume.'

/** 默认音量：0.6 —— 听得清，又不至于一开就吓人。 */
export const CAMERA_DEFAULT_VOLUME = 0.6

/**
 * 把一个来路不明的值修成一个合法音量（0–1）。
 *
 * **静音（0）是用户的选择**，不许被当成"没记住"：数字 0 与字符串 `'0'` 都原样保留。
 * 空串/空白串按**无效**处理（`Number('')` 是 0，那会把一次损坏的写入变成静音，
 * 而用户会以为"音量没记住"）。
 */
export function sanitiseCameraVolume(raw: unknown): number {
  if (typeof raw === 'string') {
    if (raw.trim() === '') return CAMERA_DEFAULT_VOLUME
  }
  const value = typeof raw === 'string' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isFinite(value)) return CAMERA_DEFAULT_VOLUME
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * 画面的翻转（业主 2026-09-18 第 10 批第 21 条：「支持左右/上下/90° 翻转」）。
 *
 * 三个**独立**开关而不是一个枚举：左右 + 上下 + 90° 可以同时成立（"左右翻转再转 90°"
 * 与"只转 90°"不是同一个画面），而一个枚举会把它们变成互斥的、丢掉组合。
 */
export interface CameraFlip {
  horizontal: boolean
  vertical: boolean
  quarter: boolean
}

export const CAMERA_FLIP_NONE: CameraFlip = { horizontal: false, vertical: false, quarter: false }

/**
 * 翻转的 CSS `transform`。
 *
 * **90° 必须配一个缩放**：这一块的外框是 16:9，把画面转 90° 之后它是竖的，不缩就会两头裁掉。
 * 16:9 的框里转 90° 后能放下的最大比例正是 **9/16 = 0.5625**，这个数是算出来的：
 * 宽 `w`、高 `9w/16` 的框里放一个旋转 90° 的 `w × 9w/16` 矩形，需要缩到
 * `min(w / (9w/16), (9w/16) / w) = 9/16`。
 */
export function cameraFlipTransform(flip: CameraFlip): string {
  const parts: string[] = []
  const scaleX = flip.horizontal ? -1 : 1
  const scaleY = flip.vertical ? -1 : 1
  if (scaleX !== 1 || scaleY !== 1) parts.push(`scale(${scaleX}, ${scaleY})`)
  if (flip.quarter) parts.push(`rotate(90deg) scale(${(9 / 16).toFixed(4)})`)
  return parts.length > 0 ? parts.join(' ') : 'none'
}

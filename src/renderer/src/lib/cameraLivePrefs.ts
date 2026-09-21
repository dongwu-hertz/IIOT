/**
 * 相机实时画面在这台机器上的**界面偏好**：音量的读写（业主 2026-09-18 第 10 批第 21 条
 * 「音量可调并**记住**」）。
 *
 * WHY localStorage AND NOT THE DATABASE
 * 与 `stores/liveWall.ts` / `composables/useLocale.ts` 同一条既有约定：这是**这台机器上
 * 这个人的看法**（"这一路声音开多大"），不是设备事实、也不是要跟着账号走的设置。
 * 写进 `window.api.settings` 会让它变成一台设备的属性，而它其实只属于坐在这里的人。
 *
 * WHY THE VOLUME IS PER DEVICE
 * 两台相机的拾音电平可以差很多（一台装在机房、一台装在车间）。记成一个全局值会让
 * "在 A 上刚刚好"的音量把 B 变成爆音或听不见。键里带设备 id，与画面墙"每格各记一份"同一条口径。
 *
 * 取值规则与翻转的几何在 `shared/domain/camera-live-prefs.ts`：那一半是纯值，单测能直接
 * 跑一遍（见那个文件的头注）。这个文件只负责"和这台机器的存储打交道"。
 */

import {
  CAMERA_DEFAULT_VOLUME,
  CAMERA_VOLUME_STORAGE_PREFIX,
  sanitiseCameraVolume
} from '@shared/domain/camera-live-prefs'

export {
  CAMERA_DEFAULT_VOLUME,
  CAMERA_FLIP_NONE,
  CAMERA_VOLUME_STORAGE_PREFIX,
  cameraFlipTransform,
  sanitiseCameraVolume,
  type CameraFlip
} from '@shared/domain/camera-live-prefs'

/** 这台设备记住的音量（没有记录时是默认值）。 */
export function loadCameraVolume(deviceId: string): number {
  if (!deviceId) return CAMERA_DEFAULT_VOLUME
  try {
    const raw = window.localStorage.getItem(`${CAMERA_VOLUME_STORAGE_PREFIX}${deviceId}`)
    if (raw === null) return CAMERA_DEFAULT_VOLUME
    return sanitiseCameraVolume(raw)
  } catch {
    // 隐私模式 / 存储被禁用：记不住不等于用不了。
    return CAMERA_DEFAULT_VOLUME
  }
}

/** 记住这台设备的音量。写失败（配额、隐私模式）时静默 —— 那是偏好，不是功能。 */
export function saveCameraVolume(deviceId: string, volume: number): void {
  if (!deviceId) return
  try {
    window.localStorage.setItem(
      `${CAMERA_VOLUME_STORAGE_PREFIX}${deviceId}`,
      String(sanitiseCameraVolume(volume))
    )
  } catch {
    /* 记不住音量不该让画面出问题 */
  }
}

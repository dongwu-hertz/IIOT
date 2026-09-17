/**
 * Settings / app-info / disk-usage store (spec section 14.4).
 *
 * `appInfo` and `diskUsage` are read-only views of main-process state; only
 * `settings` is editable, and every edit goes through `window.api.settings.update`
 * (the renderer must never persist configuration itself).
 */

import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AppInfo, AppSettings, AppSettingsPatch, DiskUsage } from '@shared/ipc/contract'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings | null>(null)
  const appInfo = ref<AppInfo | null>(null)
  const diskUsage = ref<DiskUsage | null>(null)
  const loading = ref(false)
  const saving = ref(false)
  const error = ref('')
  const savedAt = ref(0)

  const loaded = computed(() => settings.value !== null)

  async function load(): Promise<void> {
    loading.value = true
    const [settingsResult, infoResult] = await Promise.all([
      callApi(() => window.api.settings.get()),
      callApi(() => window.api.app.getInfo())
    ])
    loading.value = false

    if (!settingsResult.success) {
      error.value = resultMessage(settingsResult)
    } else {
      settings.value = unwrap(settingsResult) ?? null
      error.value = ''
    }
    if (infoResult.success) appInfo.value = unwrap(infoResult) ?? null
  }

  /**
   * Persist a partial settings patch.
   * Returns true on success so the view can show a save confirmation.
   */
  async function update(patch: AppSettingsPatch): Promise<boolean> {
    saving.value = true
    const result = await callApi(() => window.api.settings.update(patch))
    saving.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    error.value = ''
    // The main process echoes the full, normalised settings object; trust it
    // over the local draft so validation/clamping is visible to the user.
    settings.value = unwrap(result) ?? settings.value
    savedAt.value = Date.now()
    return true
  }

  /**
   * 「恢复默认值」（手册 §17.2 的 Default Value）。
   *
   * 与 `update()` 分开而不是拼一个「每个键都填默认值」的 patch：那样**恢复的范围
   * 就由界面决定**了，而它必须只有一处定义（主进程的
   * `SettingsService.RESTORABLE_SETTING_KEYS`）。这个方法不接受参数，因此它不可能
   * 被用来写别的键。
   *
   * 返回主进程**读回来**的那一份设置 —— 界面据此刷新草稿，而不是自己把默认值填上去。
   */
  async function restoreDefaults(): Promise<boolean> {
    saving.value = true
    const result = await callApi(() => window.api.settings.restoreDefaults())
    saving.value = false
    if (!result.success) {
      error.value = resultMessage(result)
      return false
    }
    error.value = ''
    settings.value = unwrap(result) ?? settings.value
    savedAt.value = Date.now()
    return true
  }

  async function loadDiskUsage(): Promise<void> {
    const result = await callApi(() => window.api.settings.diskUsage())
    if (!result.success) {
      error.value = resultMessage(result)
      return
    }
    diskUsage.value = unwrap(result) ?? null
  }

  /**
   * Opens the native directory picker. Returns the chosen path, or '' when the
   * user cancelled.
   *
   * The picked path is deliberately NOT written into `settings` here: choosing a
   * folder in the dialog does not change the stored configuration until the user
   * saves the form. Pretending otherwise would make the store describe a state
   * the main process has never accepted.
   */
  async function pickStorageDir(): Promise<string> {
    const result = await callApi(() => window.api.settings.pickStorageDir())
    if (!result.success) {
      error.value = resultMessage(result)
      return ''
    }
    // `null` means the user cancelled the dialog — that is not an error.
    return unwrap(result) ?? ''
  }

  function clearError(): void {
    error.value = ''
  }

  /**
   * 打开原生文件对话框挑一个告警声音文件（手册 §17.2.7）。
   *
   * 返回选中的**绝对路径**，`''` 表示用户取消。与 `pickStorageDir()` 同一条纪律：
   * 选中的路径**不**写进 `settings` —— 挑一个文件不等于保存了配置，草稿由组件持有。
   * 扩展名（只允许 `.wav`）在这里**不**判断：那是共享层
   * `isAcceptableAlarmSoundFile()` 的唯一职责，组件按它给出可读的拒绝理由。
   */
  async function pickAlarmSound(): Promise<string> {
    const result = await callApi(() => window.api.settings.pickAlarmSound())
    if (!result.success) {
      error.value = resultMessage(result)
      return ''
    }
    return unwrap(result) ?? ''
  }

  /**
   * Record a failure raised by a command that does not fit the load/save shape —
   * opening an external link, for instance. Without this the component would have
   * to either swallow the error or keep its own banner, and two places showing
   * the same kind of problem is how inconsistent messaging starts.
   */
  function setError(message: string): void {
    error.value = message
  }

  return {
    // state
    settings,
    appInfo,
    diskUsage,
    loading,
    saving,
    error,
    savedAt,
    // getters
    loaded,
    // actions
    load,
    update,
    restoreDefaults,
    loadDiskUsage,
    pickStorageDir,
    pickAlarmSound,
    clearError,
    setError
  }
})

/**
 * 气井泄漏监测装置的识别。
 *
 * 设备事实：AO01 在协议上与 AE08 / FA8 同族（`kind === 'acousticBox'`），不能为它
 * 新增一个 `DeviceKind` —— 那会把客户端、通道、告警、录音全部复制一遍。但它没有
 * 可用的实时音频/频谱流（真机 `features_stream` / `audio_stream` 都是 0 帧），
 * 所以界面需要一条**简化显示**的分支。
 *
 * 当前固件没有独立的型号字段；`/get_devinfo` 的 `devname` 会落到 `Device.name`
 * （默认就是 `AO01`）。因此这里按设备名识别；用户把它改名后这条分支会失效，
 * 这一点在 `docs/AO01-INTEGRATION.md` 里写明。以后若设备表增加 `modelName`，
 * 把本函数改成读那个字段即可，界面分支不用动。
 */
export function isGasLeakMonitor(
  device: { kind?: string; name?: string; firmwareVersion?: string } | undefined
): boolean {
  if (!device || device.kind !== 'acousticBox') return false
  const identity = `${device.name ?? ''} ${device.firmwareVersion ?? ''}`.trim()
  return /(^|[^A-Z0-9])AO01([^A-Z0-9]|$)/i.test(identity)
}
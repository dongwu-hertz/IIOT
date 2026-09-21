/**
 * 把一个本机绝对路径变成渲染层元素能吃的 `file://` 地址。
 *
 * `encodeURI` 是必须的：Windows 路径里的 `\` 与空格会让一个裸 `file://` 地址
 * 被 Chromium 拒绝（或者更糟，解析成一个不存在的路径）。先按 `/` 分段编码再拼，
 * 这样盘符（`E:`）与每一段名字里的特殊字符都各自被正确转义。
 *
 * 用在两处：告警声音试听（`<audio>`）与本地瓦片缓存（`<img>`，业主 20260921 批）——
 * 两处共用这一个实现，免得"同一种路径两种写法"悄悄漂移。
 */
export function toFileUrl(filePath: string): string {
  const normalised = filePath.replace(/\\/g, '/')
  const encoded = normalised
    .split('/')
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join('/')
  return `file:///${encoded.replace(/^\/+/, '')}`
}

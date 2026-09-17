/**
 * 离线**点位图**的画法 —— 纯函数，业主 2026-09-17 第 8 批第 2 条。
 *
 * ---------------------------------------------------------------------------
 * 为什么没有地图库、也没有瓦片
 * ---------------------------------------------------------------------------
 * 渲染层按设计**不联网**（`index.html` 的 CSP：`connect-src 'none'`、
 * `img-src 'self' data:`），而在线地图（高德/百度/OSM）全都要从公网取瓦片 ——
 * 那与"装在没有外网的机房里也能用"是相反的。所以这张图是**我们自己按经纬度画的平面图**：
 * 坐标轴是经纬度，设备按点位落点，没有街道与建筑。
 *
 * 业主选的就是这一条（2026-09-17 第 8 批的确认）：「用我们自己的离线点位图」。
 *
 * ---------------------------------------------------------------------------
 * 投影：等距圆柱 + 按纬度压缩经度
 * ---------------------------------------------------------------------------
 * 一个点映射成两个像素坐标，**比例一致**（这决定图上的形状像不像现场）：
 *
 *   x ∝ (lon − lon0) · cos(lat0)          y ∝ −(lat − lat0)
 *
 * `cos(lat0)` 是必须的：在北纬 31°，1° 经度的地面距离只有 1° 纬度的 ~0.857 倍；
 * 不乘它，东西向会被拉长 17%，现场两两之间的相对方位就看不出来了。
 * 负号是因为屏幕的 y 向下、而纬度向北增大（北在上）。
 *
 * 三件**我们自己定的**口径（没有一处来自设备或手册）：
 *   1. 边界由**实际录了点位的设备**决定，四周留 `padding` 像素；
 *   2. 只有一个点（或所有点重合）时，用 `MIN_SPAN_DEG` 造一个最小视野把它放在正中 ——
 *      否则除零会让它飞到画布外；
 *   3. **没有完整点位的设备不画在图上**，而是由调用方单独列出来（`withoutPoint`）：
 *      它们不是"在图上的某个位置"，把它们堆在角落里比不画更糟。
 */

/** 一个待落点的设备（只带画图需要的字段，便于单测）。 */
export interface MapDeviceInput {
  id: string
  name: string
  /** WGS84 十进制度；两个都给全才算"有点位"。 */
  latitude?: number
  longitude?: number
  /** 厂商标识（界面按它给不同图标）；这里只透传。 */
  kind?: string
}

export interface MapBounds {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

export interface MapMarker {
  id: string
  name: string
  /** 画布内的像素坐标（左上角为原点）。 */
  x: number
  y: number
  latitude: number
  longitude: number
}

export interface DeviceMapLayout {
  markers: MapMarker[]
  /** 有设备行、但没有**完整**点位的那些（界面必须单独说，而不是把它们画在原点）。 */
  withoutPoint: MapDeviceInput[]
  /** 有点位的设备的边界；一个都没有时缺席。 */
  bounds?: MapBounds
}

/**
 * 最小视野（度）。0.0005° ≈ 55 米：一台设备单独在图上时，视野大约 55 米见方 ——
 * 既不会除零到无穷大，也不会把"这台设备在厂区哪个位置"缩到看不见。
 */
export const MIN_SPAN_DEG = 0.0005

/** 纬度上限（|lat| 越大 `cos` 越接近 0，投影会退化）。 */
const MAX_ABS_LATITUDE = 89.5

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
/** 这一台有没有**完整**的点位（经纬度成对）。 */
export function hasMapPoint(device: MapDeviceInput): boolean {
  return isFiniteNumber(device.latitude) && isFiniteNumber(device.longitude)
}

/**
 * 边界：包住所有有点位的设备，并保证**两个方向都不为零**（单点/重合点用最小视野撑开）。
 */
export function mapBounds(devices: readonly MapDeviceInput[]): MapBounds | undefined {
  const points = devices.filter(hasMapPoint)
  if (points.length === 0) return undefined

  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  let minLon = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  for (const point of points) {
    minLat = Math.min(minLat, point.latitude as number)
    maxLat = Math.max(maxLat, point.latitude as number)
    minLon = Math.min(minLon, point.longitude as number)
    maxLon = Math.max(maxLon, point.longitude as number)
  }

  // 纬度不能贴到 ±90：那里 cos(lat) → 0，投影退化（真实设备不会装在那里，但库里的值可以是）。
  const clampLat = (value: number): number =>
    Math.max(-MAX_ABS_LATITUDE, Math.min(MAX_ABS_LATITUDE, value))
  const expand = (min: number, max: number): [number, number] => {
    if (max - min >= MIN_SPAN_DEG) return [min, max]
    const centre = (min + max) / 2
    return [centre - MIN_SPAN_DEG / 2, centre + MIN_SPAN_DEG / 2]
  }
  const [lonMin, lonMax] = expand(minLon, maxLon)
  const [latMin, latMax] = expand(clampLat(minLat), clampLat(maxLat))
  return { minLat: latMin, maxLat: latMax, minLon: lonMin, maxLon: lonMax }
}

/**
 * 把 `(经度, 纬度)` 映射成画布像素的**投影器**。
 *
 * 为什么单独暴露它：网格线与设备落点必须用**同一套**数学。第一版把这段算式在视图里抄了
 * 一遍（网格一个函数、落点另一个函数），只要有人改了一处，网格就会与点错位 ——
 * 而错位的表现是"设备看起来不在那个刻度上"，比画错更难发现。
 */
export interface MapProjector {
  /** 经度 → 像素 x。 */
  x(longitude: number): number
  /** 纬度 → 像素 y（**北在上**：纬度越大 y 越小）。 */
  y(latitude: number): number
  /** 每像素代表的**纬度**度数（等比投影下两个方向同一个比例，经度已按 cos 折过）。 */
  degreesPerPixel: number
}

export function mapProjector(
  bounds: MapBounds,
  width: number,
  height: number,
  padding = 28
): MapProjector {
  const usableWidth = Math.max(1, width - padding * 2)
  const usableHeight = Math.max(1, height - padding * 2)
  const latSpan = Math.max(1e-9, bounds.maxLat - bounds.minLat)
  const lonSpan = Math.max(1e-9, bounds.maxLon - bounds.minLon)
  // 按纬度压缩经度（见文件头）：同样"1 度"，经度方向的实际距离更短。
  const latCentre = (bounds.minLat + bounds.maxLat) / 2
  const lonScale = Math.max(0.01, Math.cos((latCentre * Math.PI) / 180))
  const lonSpanScaled = lonSpan * lonScale

  // 等比：两个方向取同一个 px/度（经度按上面的比例折过），所以图上的相对方位是真的。
  const scale = Math.min(usableWidth / lonSpanScaled, usableHeight / latSpan)
  const drawnWidth = lonSpanScaled * scale
  const drawnHeight = latSpan * scale
  const offsetX = padding + (usableWidth - drawnWidth) / 2
  const offsetY = padding + (usableHeight - drawnHeight) / 2

  return {
    x: (longitude: number) => offsetX + (longitude - bounds.minLon) * lonScale * scale,
    y: (latitude: number) => offsetY + (bounds.maxLat - latitude) * scale,
    degreesPerPixel: 1 / scale
  }
}

/**
 * 把一批设备铺到 `width × height` 的画布上。
 *
 * `padding` 是四周的留白（像素）：标记本身有半径、名字要写在旁边，贴着边画会被裁掉。
 * 画布太小时（宽或高不够两倍留白）按 0 留白处理，而不是算出负的可用空间。
 */
export function deviceMapLayout(
  devices: readonly MapDeviceInput[],
  width: number,
  height: number,
  padding = 28
): DeviceMapLayout {
  const withoutPoint = devices.filter((device) => !hasMapPoint(device))
  const bounds = mapBounds(devices)
  if (!bounds) return { markers: [], withoutPoint }

  const project = mapProjector(bounds, width, height, padding)
  const markers = devices.filter(hasMapPoint).map((device) => {
    const lon = device.longitude as number
    const lat = device.latitude as number
    return {
      id: device.id,
      name: device.name,
      x: Math.round(project.x(lon) * 100) / 100,
      y: Math.round(project.y(lat) * 100) / 100,
      latitude: lat,
      longitude: lon
    }
  })

  return { markers, withoutPoint, bounds }
}

/**
 * 画网格用的经纬度刻度：从边界出发按"好看的步长"（1/2/5 × 10^n）取，最多 `maxLines` 条。
 *
 * 为什么不让调用方直接写一个步长：视野小到一个厂区（0.01°）与大到跨省（5°）时，
 * 同一个步长不是密到糊成一片就是稀到没有参照。
 */
export function mapGridSteps(bounds: MapBounds, maxLines = 6): { lat: number[]; lon: number[] } {
  const niceStep = (span: number): number => {
    const target = span / Math.max(1, maxLines - 1)
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(target, 1e-9))))
    for (const factor of [1, 2, 5, 10]) {
      if (factor * magnitude >= target) return factor * magnitude
    }
    return 10 * magnitude
  }
  const ticks = (min: number, max: number): number[] => {
    const step = niceStep(max - min)
    const out: number[] = []
    const start = Math.ceil(min / step) * step
    for (let value = start; value <= max + step / 1e6 && out.length < 40; value += step) {
      // 浮点累加会漂（0.30000000000000004）：按步长的小数位收一下。
      const decimals = Math.max(0, Math.min(8, -Math.floor(Math.log10(step)) + 1))
      out.push(Number(value.toFixed(decimals)))
    }
    return out
  }
  return { lat: ticks(bounds.minLat, bounds.maxLat), lon: ticks(bounds.minLon, bounds.maxLon) }
}

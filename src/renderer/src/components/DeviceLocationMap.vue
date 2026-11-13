<script setup lang="ts">
/**
 * 设备位置内嵌地图（设备详情页「Device location」卡片）。
 *
 * 业主 2026-11-12：Auscultation Box 这一族的产品应该把地图放在设备详情页上，而不是
 * 只给一个「在地图信息里查看」的文字链接。这里复用地图页的同一套离线优先瓦片投影：
 *   - 视图以设备点位为中心，固定 16 级缩放；
 *   - 方向优先取最近一条告警原文的 `horizontal`，没有告警时取安装方位角；
 *   - 范围按 100 m、±18° 画扇区；
 *   - 瓦片加载失败时保留下面的经纬度网格，不会变成一块白。
 *
 * 这一段只负责**显示**：录入仍在设备管理的编辑对话框，避免同一份点位出现第三套输入框。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmEvent, DeviceInstallation } from '@shared/domain/models'
import { isPointComplete } from '@shared/domain/device-installation'
import { offsetMapPoint } from '@shared/domain/device-map'
import {
  defaultMapTilesConfig,
  projectToViewport,
  viewTiles,
  type MapTilesConfig
} from '@shared/domain/map-tiles'
import { deviceMapLink } from '@renderer/lib/deviceMapLink'
import { useSettingsStore } from '@renderer/stores/settings'
import { callApi, unwrap } from '@renderer/lib/result'

const props = defineProps<{
  installation?: DeviceInstallation
  deviceId?: string
  deviceName?: string
}>()

const { t } = useI18n()
const settings = useSettingsStore()

const WIDTH = 960
const HEIGHT = 540
const DEFAULT_ZOOM = 16
const RANGE_METRES = 100
const SPREAD_DEG = 18

const zoom = ref(DEFAULT_ZOOM)

const hasPoint = computed(
  () =>
    isPointComplete(props.installation) &&
    props.installation?.gisLatitude !== undefined &&
    props.installation?.gisLongitude !== undefined
)

const tileConfig = computed<MapTilesConfig>(() => {
  const configured = settings.settings?.mapTiles ?? defaultMapTilesConfig()
  // 设备详情里的小地图默认展示底图；离线时瓦片失败会自动露出网格。
  return { ...configured, enabled: true }
})

const tilePlacements = computed(() => {
  if (!hasPoint.value) return []
  return viewTiles(
    tileConfig.value,
    {
      latitude: props.installation?.gisLatitude as number,
      longitude: props.installation?.gisLongitude as number,
      zoom: zoom.value
    },
    zoom.value,
    WIDTH,
    HEIGHT
  )
})

const failedTiles = ref<Set<string>>(new Set())

function hideFailedTile(key: string): void {
  failedTiles.value = new Set(failedTiles.value).add(key)
}

const centre = computed(() => ({
  latitude: props.installation?.gisLatitude as number,
  longitude: props.installation?.gisLongitude as number,
  zoom: zoom.value
}))

/** 最近一条告警（只取一条；方向以设备原文的 horizontal 为准）。 */
const latestAlarm = ref<AlarmEvent | undefined>()

async function loadLatestAlarm(): Promise<void> {
  if (!props.deviceId) return
  const result = await callApi(() => window.api.alarms.query({ deviceId: props.deviceId, limit: 1 }))
  latestAlarm.value = result.success ? unwrap(result)?.items?.[0] : undefined
}

function alarmHorizontal(alarm: AlarmEvent | undefined): number | undefined {
  if (!alarm?.deviceRaw) return undefined
  try {
    const value = Number((JSON.parse(alarm.deviceRaw) as Record<string, unknown>).horizontal)
    return Number.isFinite(value) ? ((value % 360) + 360) % 360 : undefined
  } catch {
    return undefined
  }
}

/** 告警方向优先；没有告警时用安装方位角。没有方向就不画线，不猜 0°。 */
const heading = computed(() => {
  const relative = alarmHorizontal(latestAlarm.value)
  const offset = props.installation?.azimuthDeg
  if (relative === undefined) return offset
  return ((relative + (offset ?? 0)) % 360 + 360) % 360
})

const marker = computed(() => ({ x: WIDTH / 2, y: HEIGHT / 2 }))

const directionEnd = computed(() => {
  if (!hasPoint.value || heading.value === undefined) return undefined
  const point = offsetMapPoint(
    props.installation?.gisLatitude as number,
    props.installation?.gisLongitude as number,
    heading.value,
    RANGE_METRES
  )
  return projectToViewport(centre.value, point.latitude, point.longitude, WIDTH, HEIGHT)
})

const sectorPoints = computed(() => {
  if (!hasPoint.value || heading.value === undefined) return ''
  const points: string[] = [`${marker.value.x},${marker.value.y}`]
  for (let step = -SPREAD_DEG; step <= SPREAD_DEG; step += SPREAD_DEG / 6) {
    const point = offsetMapPoint(
      props.installation?.gisLatitude as number,
      props.installation?.gisLongitude as number,
      heading.value + step,
      RANGE_METRES
    )
    const projected = projectToViewport(centre.value, point.latitude, point.longitude, WIDTH, HEIGHT)
    points.push(`${projected.x.toFixed(1)},${projected.y.toFixed(1)}`)
  }
  return points.join(' ')
})

const mapLink = computed(() => deviceMapLink(props.deviceId ?? ''))

function zoomIn(): void {
  zoom.value = Math.min(18, zoom.value + 1)
}

function zoomOut(): void {
  zoom.value = Math.max(2, zoom.value - 1)
}

async function autoAdjust(): Promise<void> {
  zoom.value = 16
  await loadLatestAlarm()
}

let alarmRefreshTimer: number | undefined

onMounted(async () => {
  if (!settings.loaded) await settings.load()
  await loadLatestAlarm()
  alarmRefreshTimer = window.setInterval(() => void loadLatestAlarm(), 5_000)
})

watch(
  () => props.deviceId,
  () => void loadLatestAlarm()
)
onBeforeUnmount(() => {
  if (alarmRefreshTimer !== undefined) window.clearInterval(alarmRefreshTimer)
})
</script>
<template>
  <section class="device-location-map" data-device-location-map>
    <div v-if="!hasPoint" class="device-location-map__empty" data-device-location-empty></div>

    <template v-else>
      <div class="device-location-map__canvas">
        <div class="device-location-map__tiles" data-device-location-tiles>
          <img
            v-for="tile in tilePlacements"
            v-show="!failedTiles.has(tile.key)"
            :key="tile.key"
            class="device-location-map__tile"
            :src="tile.url"
            :style="{ left: `${(tile.left / 960) * 100}%`, top: `${(tile.top / 540) * 100}%` }"
            alt=""
            draggable="false"
            loading="lazy"
            @error="hideFailedTile(tile.key)"
          />
        </div>
        <svg class="device-location-map__svg" viewBox="0 0 960 540" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <pattern id="device-location-grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M 48 0 L 0 0 0 48" fill="none" class="device-location-map__grid-line" />
            </pattern>
          </defs>
          <rect width="960" height="540" fill="url(#device-location-grid)" class="device-location-map__grid" />
          <g v-if="heading !== undefined">
            <polygon :points="sectorPoints" class="device-location-map__sector" />
            <line
              :x1="marker.x"
              :y1="marker.y"
              :x2="directionEnd?.x"
              :y2="directionEnd?.y"
              class="device-location-map__direction"
            />
          </g>
          <circle :cx="marker.x" :cy="marker.y" r="10" class="device-location-map__dot" />
          <circle :cx="marker.x" :cy="marker.y" r="18" class="device-location-map__ring" />
          <text :x="marker.x" :y="marker.y + 38" text-anchor="middle" class="device-location-map__name">
            {{ deviceName ?? '' }}
          </text>
          <text x="24" y="38" class="device-location-map__compass">N</text>
          <text x="24" y="70" class="device-location-map__meta-text">
            {{ t('installUi.mapRange', { range: RANGE_METRES }) }}
          </text>
        </svg>
        <div class="device-location-map__controls" @pointerdown.stop @wheel.stop>
          <button type="button" :title="t('mapPickerUi.zoomIn')" :aria-label="t('mapPickerUi.zoomIn')" data-location-zoom-in @click="zoomIn">+</button>
          <button type="button" :title="t('mapPickerUi.zoomOut')" :aria-label="t('mapPickerUi.zoomOut')" data-location-zoom-out @click="zoomOut">−</button>
          <button type="button" :title="t('mapUi.autoFocus')" :aria-label="t('mapUi.autoFocus')" data-location-auto @click="autoAdjust">{{ t('mapUi.autoFocus') }}</button>
        </div>
      </div>
      <div class="device-location-map__footer">
        <span class="mono">{{ installation?.gisLatitude }}, {{ installation?.gisLongitude }}</span>
        <span v-if="heading !== undefined">{{ t('installUi.mapDirection', { degrees: Math.round(heading) }) }}</span>
        <span v-else class="muted">{{ t('installUi.mapNoAzimuth') }}</span>
        <RouterLink v-if="deviceId" class="btn btn--sm btn--ghost" :to="mapLink">
          {{ t('installUi.viewOnMap') }}
        </RouterLink>
      </div>
    </template>
  </section>
</template>

<style scoped>
.device-location-map {
  margin-top: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-bg-subtle);
}

.device-location-map__empty {
  display: grid;
  gap: var(--space-2);
  justify-items: start;
  padding: var(--space-4);
}

.device-location-map__empty-title {
  margin: 0;
  font-weight: 600;
}

.device-location-map__canvas {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--color-bg-subtle) 88%, var(--color-accent)), var(--color-bg-subtle));
}

.device-location-map__tiles {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.device-location-map__tile {
  position: absolute;
  width: 26.6667%;
  height: 47.4074%;
  object-fit: cover;
  user-select: none;
}

.device-location-map__svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.device-location-map__grid-line {
  stroke: color-mix(in srgb, var(--color-border) 72%, transparent);
  stroke-width: 1;
}

.device-location-map__grid {
  fill-opacity: 0.32;
}

.device-location-map__sector {
  fill: color-mix(in srgb, var(--color-accent) 20%, transparent);
  stroke: color-mix(in srgb, var(--color-accent) 60%, transparent);
  stroke-width: 1;
  stroke-dasharray: 5 4;
}

.device-location-map__direction {
  stroke: var(--color-accent);
  stroke-width: 3;
  stroke-linecap: round;
}

.device-location-map__dot {
  fill: var(--color-accent);
}

.device-location-map__ring {
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 1.5;
  opacity: 0.65;
}

.device-location-map__name,
.device-location-map__compass,
.device-location-map__meta-text {
  font-size: 14px;
  fill: var(--color-text-secondary);
  paint-order: stroke;
  stroke: var(--color-bg);
  stroke-width: 3px;
}

.device-location-map__compass {
  font-weight: 700;
  fill: var(--color-accent);
}

.device-location-map__controls {
  position: absolute;
  top: 10px;
  right: 10px;
  display: flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-bg) 88%, transparent);
  backdrop-filter: blur(4px);
}

.device-location-map__controls button {
  min-width: 28px;
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
}

.device-location-map__controls button:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}
.device-location-map__footer {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: center;
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border);
  font-size: var(--font-size-sm);
}

.device-location-map__footer .btn {
  margin-left: auto;
}
</style>

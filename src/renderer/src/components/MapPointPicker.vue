<script setup lang="ts">
/**
 * 设备 GIS 点位的「在地图上选点」弹窗。
 *
 * 复用地图页同一套 `map-tiles` 纯函数：`viewTiles()` 铺瓦片、`projectToViewport()`
 * 画标记、世界坐标逆变换把点击位置换回经纬度。地图配置关闭时**不加载任何在线瓦片**，
 * 只显示网格与标记 —— 离线优先的承诺不变，但选点仍然可用。
 *
 * 交互只有三件事：点击地图落点、缩放、确认。拖拽平移第一版不做：选点场景下先用
 * 当前点位/时区中心，再缩放点击足够；以后要拖拽时直接加 `panMapCenter()` 即可。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '@renderer/components/AppModal.vue'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  clampTileZoom,
  defaultMapTilesConfig,
  latToWorldY,
  lonToWorldX,
  projectToViewport,
  timeZoneCenter,
  viewTiles,
  worldXToLon,
  worldYToLat,
  type MapCenter
} from '@shared/domain/map-tiles'

const props = defineProps<{
  open: boolean
  latitude?: number
  longitude?: number
}>()

const emit = defineEmits<{
  (event: 'close'): void
  (event: 'pick', value: { latitude: number; longitude: number }): void
}>()

const { t } = useI18n()
const settings = useSettingsStore()

const WIDTH = 960
const HEIGHT = 540
const DEFAULT_ZOOM = 14

const center = ref<MapCenter>({ latitude: 30, longitude: 110, zoom: DEFAULT_ZOOM })
const marker = ref<{ latitude: number; longitude: number } | null>(null)
const tileErrors = ref<Record<string, boolean>>({})

const tileConfig = computed(() => settings.settings?.mapTiles ?? defaultMapTilesConfig())
const tiles = computed(() =>
  tileConfig.value.enabled
    ? viewTiles(tileConfig.value, center.value, center.value.zoom, WIDTH, HEIGHT)
    : []
)
const markerPoint = computed(() =>
  marker.value === null
    ? null
    : projectToViewport(
        center.value,
        marker.value.latitude,
        marker.value.longitude,
        WIDTH,
        HEIGHT
      )
)

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function resetFromProps(): void {
  const lat = props.latitude
  const lon = props.longitude
  if (finite(lat) && finite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    center.value = { latitude: lat, longitude: lon, zoom: DEFAULT_ZOOM }
    marker.value = { latitude: lat, longitude: lon }
    return
  }
  const configured = settings.settings?.mapTiles?.defaultCenter
  if (configured !== undefined) {
    center.value = {
      latitude: configured.lat,
      longitude: configured.lon,
      zoom: clampTileZoom(configured.zoom)
    }
  } else {
    center.value = timeZoneCenter(Intl.DateTimeFormat().resolvedOptions().timeZone)
  }
  marker.value = null
}

watch(
  () => props.open,
  (open) => {
    if (!open) return
    tileErrors.value = {}
    if (!settings.loaded) void settings.load()
    resetFromProps()
  },
  { immediate: true }
)

function tileStyle(tile: { left: number; top: number }): Record<string, string> {
  return {
    left: `${((tile.left / WIDTH) * 100).toFixed(4)}%`,
    top: `${((tile.top / HEIGHT) * 100).toFixed(4)}%`,
    width: `${((256 / WIDTH) * 100).toFixed(4)}%`,
    height: `${((256 / HEIGHT) * 100).toFixed(4)}%`
  }
}

function hideTile(key: string): void {
  tileErrors.value = { ...tileErrors.value, [key]: true }
}

function pickAt(event: MouseEvent): void {
  const element = event.currentTarget as HTMLElement | null
  if (!element) return
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return
  const x = ((event.clientX - rect.left) / rect.width) * WIDTH
  const y = ((event.clientY - rect.top) / rect.height) * HEIGHT
  const zoom = clampTileZoom(center.value.zoom)
  const worldX = lonToWorldX(center.value.longitude, zoom) + x - WIDTH / 2
  const worldY = latToWorldY(center.value.latitude, zoom) + y - HEIGHT / 2
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, worldYToLat(worldY, zoom)))
  const longitude = worldXToLon(worldX, zoom)
  marker.value = { latitude, longitude }
}

function zoomBy(delta: number): void {
  center.value = {
    ...center.value,
    zoom: clampTileZoom(center.value.zoom + delta)
  }
}

function confirm(): void {
  const point = marker.value ?? {
    latitude: center.value.latitude,
    longitude: center.value.longitude
  }
  emit('pick', point)
  emit('close')
}
</script>

<template>
  <AppModal
    :model-value="open"
    :title="t('mapPickerUi.title')"
    width="980px"
    @update:model-value="(value) => { if (!value) emit('close') }"
  >
    <div class="map-picker" data-map-picker>
      <div class="map-picker__frame" @click="pickAt">
        <img
          v-for="tile in tiles"
          v-show="!tileErrors[tile.key]"
          :key="tile.key"
          class="map-picker__tile"
          :src="tile.url"
          :style="tileStyle(tile)"
          alt=""
          @error="hideTile(tile.key)"
        />
        <svg class="map-picker__overlay" :viewBox="`0 0 ${WIDTH} ${HEIGHT}`" aria-hidden="true">
          <g class="map-picker__grid">
            <line v-for="x in 11" :key="`x${x}`" :x1="(x - 1) * 96" y1="0" :x2="(x - 1) * 96" :y2="HEIGHT" />
            <line v-for="y in 7" :key="`y${y}`" x1="0" :y1="(y - 1) * 90" :x2="WIDTH" :y2="(y - 1) * 90" />
          </g>
          <g v-if="markerPoint" class="map-picker__marker">
            <circle :cx="markerPoint.x" :cy="markerPoint.y" r="10" />
            <circle :cx="markerPoint.x" :cy="markerPoint.y" r="3" />
          </g>
        </svg>
        <div class="map-picker__controls">
          <button type="button" class="btn btn--icon" :aria-label="t('mapPickerUi.zoomIn')" @click.stop="zoomBy(1)">+</button>
          <button type="button" class="btn btn--icon" :aria-label="t('mapPickerUi.zoomOut')" @click.stop="zoomBy(-1)">−</button>
        </div>
        <div v-if="tileConfig.attribution && tileConfig.enabled" class="map-picker__attribution">
          {{ tileConfig.attribution }}
        </div>
      </div>

      <p v-if="!tileConfig.enabled" class="muted map-picker__offline">
        {{ t('mapPickerUi.offlineHint') }}
      </p>
      <p class="map-picker__hint">
        {{ marker === null ? t('mapPickerUi.hint') : t('mapPickerUi.selected', { lat: marker.latitude.toFixed(6), lon: marker.longitude.toFixed(6) }) }}
      </p>
    </div>

    <template #footer>
      <button type="button" class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button type="button" class="btn btn--primary" data-action="confirm-map-point" @click="confirm">
        {{ t('mapPickerUi.confirm') }}
      </button>
    </template>
  </AppModal>
</template>

<style scoped>
.map-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.map-picker__frame {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken, #eef2f5);
  cursor: crosshair;
}

.map-picker__tile {
  position: absolute;
  display: block;
  user-select: none;
  pointer-events: none;
}

.map-picker__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.map-picker__grid line {
  stroke: color-mix(in srgb, var(--color-border-strong) 55%, transparent);
  stroke-width: 1;
}

.map-picker__marker circle:first-child {
  fill: color-mix(in srgb, var(--color-accent) 25%, transparent);
  stroke: var(--color-accent);
  stroke-width: 2;
}

.map-picker__marker circle:last-child {
  fill: var(--color-accent);
}

.map-picker__controls {
  position: absolute;
  right: 10px;
  top: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.map-picker__attribution {
  position: absolute;
  left: 6px;
  bottom: 4px;
  font-size: 10px;
  color: var(--color-text-tertiary);
  background: color-mix(in srgb, var(--color-surface) 75%, transparent);
  padding: 1px 4px;
  border-radius: 2px;
}

.map-picker__offline,
.map-picker__hint {
  margin: 0;
  font-size: 12.5px;
}
</style>

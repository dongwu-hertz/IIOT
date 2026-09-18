<script setup lang="ts">
/**
 * **点位图**（业主 2026-09-17 第 8 批第 2 条）：设备按录入的 WGS84 点位落在一张平面图上，
 * 点一台声呐就能看到它的告警与那次告警的**球机抓图**。
 *
 * ---------------------------------------------------------------------------
 * 三件必须说清楚的事
 * ---------------------------------------------------------------------------
 * 1. **底图是我们自己画的**（`shared/domain/device-map.ts`）。渲染层不联网、仓库里也没有地图库，
 *    所以图上只有经纬度网格与落点，没有街道与建筑。业主选的就是这一条。
 * 2. **没录点位的设备不画在图上**，而是单独列出来：它们不是"在图上的某个位置"，
 *    把它们堆在角落比不画更糟（点一下会以为是别人的点位）。补录入口写在那一句下面。
 * 3. **抓图有三种状态，界面分开说**：有图 / 设备上本来就没有（`not-captured`）/
 *    库里记着但文件已不在（`files-gone`）。合成一句"没有图"会让操作员以为同步坏了。
 *
 * 抓图与相机直播一样走**主进程回环 HTTP**（图片字节不过 IPC）：`alarms.snapshot_dir` 记的是
 * 本机磁盘上的目录，渲染层读不了文件。离开这一页时会显式关掉那个端点（TTL 是兜底）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AlarmEvent, Device } from '@shared/domain/models'
import type { E2AlarmSnapshotView, E2SyncOutcome } from '@shared/ipc/contract'
import {
  deviceMapLayout,
  mapGridSteps,
  mapProjector,
  type MapDeviceInput
} from '@shared/domain/device-map'
import { isPointComplete } from '@shared/domain/device-installation'
import { useDevicesStore } from '@renderer/stores/devices'
import { callApi, resultMessage, unwrap } from '@renderer/lib/result'
import { formatDateTime, formatNumber } from '@renderer/lib/format'
import EmptyState from '@renderer/components/EmptyState.vue'
import StatusBadge from '@renderer/components/StatusBadge.vue'

const { t } = useI18n()
const devices = useDevicesStore()

/** 画布的逻辑尺寸：SVG 用 `viewBox` 缩放到容器宽度，所以这是一套"逻辑坐标"。 */
const CANVAS = { width: 760, height: 460 }

const loading = ref(false)
const selectedId = ref('')
const alarms = ref<AlarmEvent[]>([])
const alarmsLoading = ref(false)
const selectedAlarmId = ref('')
const snapshots = ref<E2AlarmSnapshotView | null>(null)
const snapshotsLoading = ref(false)
const syncing = ref(false)
const syncOutcome = ref<E2SyncOutcome | null>(null)
const actionError = ref('')

/**
 * 图上的输入：**只有录全了点位的设备**（经纬度成对，`isPointComplete` 与录入侧同一判据）。
 *
 * 这里刻意把"半个点位"和"没有点位"都交给 `withoutPoint`：一台只录了纬度的设备在图上是
 * 一个没有意义的点，而它出现在"未录入点位"那一列时，操作员知道该去补什么。
 */
const mapInputs = computed<MapDeviceInput[]>(() =>
  devices.devices.map((device) => {
    const installation = device.installation
    const input: MapDeviceInput = { id: device.id, name: device.name, kind: device.kind }
    if (
      installation &&
      isPointComplete(installation) &&
      installation.gisLatitude !== undefined &&
      installation.gisLongitude !== undefined
    ) {
      input.latitude = installation.gisLatitude
      input.longitude = installation.gisLongitude
    }
    return input
  })
)

const layout = computed(() => deviceMapLayout(mapInputs.value, CANVAS.width, CANVAS.height))
const grid = computed(() => {
  const bounds = layout.value.bounds
  return bounds ? mapGridSteps(bounds) : { lat: [], lon: [] }
})

/**
 * 网格线与设备落点用**同一个投影器**（`mapProjector`）：抄第二份算式迟早会与点错位，
 * 而错位的表现是"设备看起来不在那个刻度上"。
 */
const project = computed(() => {
  const bounds = layout.value.bounds
  return bounds ? mapProjector(bounds, CANVAS.width, CANVAS.height) : null
})

function gridLineY(latitude: number): number {
  return project.value ? project.value.y(latitude) : 0
}

function gridLineX(longitude: number): number {
  return project.value ? project.value.x(longitude) : 0
}

const selectedDevice = computed<Device | undefined>(() =>
  selectedId.value === '' ? undefined : devices.byId(selectedId.value)
)

/** 这一台是不是**空气声呐**（只有它才有球机抓图那一套）。 */
const selectedIsSonar = computed(
  () => selectedDevice.value?.kind === 'auscultationBox' && selectedDevice.value?.e2Variant === 'airSonar'
)

const pointText = computed(() => {
  const installation = selectedDevice.value?.installation
  if (!installation || installation.gisLatitude === undefined) return t('installUi.unset')
  return `${installation.gisLatitude}, ${installation.gisLongitude}`
})

function selectDevice(deviceId: string): void {
  selectedId.value = deviceId
  selectedAlarmId.value = ''
  snapshots.value = null
  void loadAlarms(deviceId)
  void closeSnapshots()
}

async function loadAlarms(deviceId: string): Promise<void> {
  alarmsLoading.value = true
  const result = await callApi(() => window.api.alarms.query({ deviceId, limit: 20 }))
  alarmsLoading.value = false
  if (!result.success) {
    actionError.value = resultMessage(result)
    alarms.value = []
    return
  }
  actionError.value = ''
  alarms.value = unwrap(result)?.items ?? []
}

/**
 * 同步这台设备的告警与录音。
 *
 * `downloadSpectrograms: true` 是**这一页存在的理由**：抓图要在同步时下下来才有得看
 * （SN-16 是 3 张球机抓图）。代价写在面板上：一条告警最多 3 次请求。
 */
async function syncNow(): Promise<void> {
  const device = selectedDevice.value
  if (!device) return
  syncing.value = true
  syncOutcome.value = null
  actionError.value = ''
  const result = await callApi(() =>
    window.api.e2.syncAlarms(device.id, { limit: 200, downloadAudio: true, downloadSpectrograms: true })
  )
  syncing.value = false
  if (!result.success) {
    actionError.value = resultMessage(result)
    return
  }
  syncOutcome.value = unwrap(result) ?? null
  await loadAlarms(device.id)
}

async function openSnapshots(alarm: AlarmEvent): Promise<void> {
  const device = selectedDevice.value
  if (!device) return
  selectedAlarmId.value = alarm.id
  snapshots.value = null
  snapshotsLoading.value = true
  const result = await callApi(() => window.api.e2.alarmSnapshots(device.id, alarm.id))
  snapshotsLoading.value = false
  if (!result.success) {
    actionError.value = resultMessage(result)
    return
  }
  actionError.value = ''
  snapshots.value = unwrap(result) ?? null
}

async function closeSnapshots(): Promise<void> {
  await callApi(() => window.api.e2.closeSnapshots())
}

onMounted(async () => {
  loading.value = true
  if (devices.devices.length === 0) await devices.load()
  // 默认选第一台**有点位**的设备：一进页面就该有东西可看。
  const first = layout.value.markers[0]
  if (first) selectDevice(first.id)
  loading.value = false
})

onUnmounted(() => {
  void closeSnapshots()
})
</script>

<template>
  <div class="page">
    <p v-if="actionError" class="alert alert--danger" role="alert">{{ actionError }}</p>

    <EmptyState v-if="devices.devices.length === 0" :title="t('devices.empty')" />

    <div v-else class="map-layout">
      <section class="card map-panel">
        <div class="section-header">
          <h3 class="section-title">{{ t('mapUi.mapTitle') }}</h3>
          <span class="muted" data-map-counts>
            {{
              t('mapUi.counts', {
                withPoint: layout.markers.length,
                total: devices.devices.length
              })
            }}
          </span>
        </div>

        <!--
          「一台点位都没有」与「有设备但都没录点位」是两件事：前者说"这一页还没有数据"，
          后者说"去设备管理补录"。所以空态用的是 `layout.markers`，不是设备表是不是空的。
        -->
        <p v-if="layout.markers.length === 0" class="alert alert--warning" data-map-empty>
          {{ t('mapUi.noPoints') }}
        </p>
        <p v-else class="muted map-panel__hint">{{ t('mapUi.selectHint') }}</p>

        <svg
          v-if="layout.markers.length > 0"
          class="map-canvas"
          :viewBox="`0 0 ${CANVAS.width} ${CANVAS.height}`"
          role="img"
          :aria-label="t('mapUi.mapTitle')"
          data-map-canvas
        >
          <rect x="0" y="0" :width="CANVAS.width" :height="CANVAS.height" class="map-canvas__bg" />
          <!-- 经纬度网格：视野小时步长自动变小（`mapGridSteps`）。 -->
          <g class="map-grid">
            <line
              v-for="latitude in grid.lat"
              :key="`lat-${latitude}`"
              :x1="0"
              :x2="CANVAS.width"
              :y1="gridLineY(latitude)"
              :y2="gridLineY(latitude)"
            />
            <line
              v-for="longitude in grid.lon"
              :key="`lon-${longitude}`"
              :x1="gridLineX(longitude)"
              :x2="gridLineX(longitude)"
              :y1="0"
              :y2="CANVAS.height"
            />
          </g>
          <g
            v-for="marker in layout.markers"
            :key="marker.id"
            class="map-marker"
            :class="{ 'map-marker--active': marker.id === selectedId }"
            :transform="`translate(${marker.x} ${marker.y})`"
            role="button"
            tabindex="0"
            :data-map-marker="marker.id"
            @click="selectDevice(marker.id)"
            @keydown.enter.prevent="selectDevice(marker.id)"
            @keydown.space.prevent="selectDevice(marker.id)"
          >
            <circle r="7" class="map-marker__dot" />
            <text class="map-marker__label" x="10" y="4">{{ marker.name }}</text>
          </g>
        </svg>

        <!--
          没录点位的设备**单独列出来**：它们不在图上的任何位置，混进图里会被读成"落点在这里"。
        -->
        <div v-if="layout.withoutPoint.length > 0" class="map-missing" data-map-without-point>
          <p class="muted map-missing__title">
            {{ t('mapUi.withoutPointTitle', { count: layout.withoutPoint.length }) }}
          </p>
          <ul class="map-missing__list">
            <li v-for="device in layout.withoutPoint" :key="device.id">
              <RouterLink :to="`/devices/${device.id}`">{{ device.name }}</RouterLink>
            </li>
          </ul>
          <p class="muted map-missing__hint">{{ t('mapUi.withoutPointHint') }}</p>
        </div>
      </section>

      <aside class="card map-side" data-map-side>
        <template v-if="selectedDevice">
          <div class="section-header">
            <h3 class="section-title">{{ selectedDevice.name }}</h3>
            <StatusBadge :status="selectedDevice.status" :connection-type="selectedDevice.connectionType" />
          </div>

          <dl class="kv">
            <div class="kv__item">
              <dt class="kv__label">{{ t('mapUi.point') }}</dt>
              <dd class="kv__value mono">{{ pointText }}</dd>
            </div>
            <div class="kv__item">
              <dt class="kv__label">{{ t('installUi.azimuth') }}</dt>
              <dd class="kv__value">
                {{
                  selectedDevice.installation?.azimuthDeg === undefined
                    ? t('installUi.unset')
                    : `${selectedDevice.installation?.azimuthDeg}°`
                }}
              </dd>
            </div>
          </dl>

          <div class="btn-row">
            <RouterLink class="btn btn--sm" :to="`/devices/${selectedDevice.id}`">
              {{ t('devicesUi.configure') }}
            </RouterLink>
            <RouterLink class="btn btn--sm" :to="`/monitor?device=${selectedDevice.id}`">
              {{ t('devicesUi.viewColumn') }}
            </RouterLink>
            <button
              v-if="selectedDevice.kind === 'auscultationBox'"
              type="button"
              class="btn btn--primary btn--sm"
              :disabled="syncing"
              data-action="map-sync"
              @click="syncNow"
            >
              {{ syncing ? t('mapUi.syncing') : t('mapUi.sync') }}
            </button>
          </div>

          <p v-if="syncOutcome" class="muted map-panel__hint" data-map-sync-outcome>
            {{
              t('mapUi.syncOutcome', {
                created: syncOutcome.alarmsCreated,
                existing: syncOutcome.alarmsExisting,
                linked: syncOutcome.snapshotsLinked,
                missing: syncOutcome.filesMissing
              })
            }}
          </p>

          <!-- 告警列表：这一页只关心"这台设备的告警 + 抓图"。 -->
          <div class="section-header map-side__sub">
            <h4 class="section-title">{{ t('mapUi.alarmsTitle') }}</h4>
            <span v-if="alarms.length > 0" class="muted">
              {{ t('mapUi.alarmCount', { count: alarms.length }) }}
            </span>
          </div>

          <p v-if="alarmsLoading" class="muted">{{ t('common.loading') }}</p>
          <p v-else-if="alarms.length === 0" class="muted" data-map-no-alarms>
            {{ t('mapUi.noAlarms') }}
          </p>
          <ul v-else class="map-alarms">
            <li v-for="alarm in alarms" :key="alarm.id">
              <button
                type="button"
                class="map-alarms__item"
                :class="{ 'map-alarms__item--active': alarm.id === selectedAlarmId }"
                :data-alarm-id="alarm.id"
                @click="openSnapshots(alarm)"
              >
                <span class="map-alarms__time">{{ formatDateTime(alarm.timestamp) }}</span>
                <span class="map-alarms__value">
                  {{ alarm.spl === undefined ? '—' : `${formatNumber(alarm.spl, 1)} dB` }}
                </span>
                <span class="badge" :class="alarm.snapshotDir ? 'badge--success' : ''">
                  {{ alarm.snapshotDir ? t('mapUi.hasSnapshot') : t('mapUi.noSnapshot') }}
                </span>
              </button>
            </li>
          </ul>

          <!--
            抓图：三种状态分开说（有图 / 设备上本来没有 / 库里记着但文件已不在）。
            `img` 的地址是主进程回环端点（含每会话令牌），CSP 只放行 `127.0.0.1`。
          -->
          <div v-if="selectedAlarmId" class="map-snapshots" data-map-snapshots>
            <div class="section-header">
              <h4 class="section-title">{{ t('mapUi.snapshotTitle') }}</h4>
              <span v-if="snapshots?.state === 'ok'" class="muted">
                {{ t('mapUi.snapshotCount', { count: snapshots.files.length }) }}
              </span>
            </div>
            <p v-if="snapshotsLoading" class="muted">{{ t('mapUi.snapshotLoading') }}</p>
            <template v-else-if="snapshots">
              <p v-if="snapshots.state === 'not-captured'" class="alert alert--warning" data-snapshot-not-captured>
                {{ t('mapUi.snapshotNotCaptured') }}
              </p>
              <p v-else-if="snapshots.state === 'files-gone'" class="alert alert--warning" data-snapshot-files-gone>
                {{ t('mapUi.snapshotFilesGone') }}
              </p>
              <div v-else class="map-snapshots__grid">
                <figure v-for="file in snapshots.files" :key="file.name">
                  <img :src="file.url" :alt="file.name" loading="lazy" />
                  <figcaption class="muted">{{ file.name }}</figcaption>
                </figure>
              </div>
            </template>
          </div>

          <p v-if="selectedIsSonar" class="muted map-panel__hint">{{ t('mapUi.sonarHint') }}</p>
        </template>

        <p v-else class="muted">{{ t('mapUi.pickOne') }}</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/*
 * 两列：左边图、右边这一台的事实与抓图。窄窗口折成一列（与设备管理页同一套做法：
 * `minmax(0, …)` 让图能真的变窄，而不是被内容顶出横向滚动条）。
 */
.map-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(280px, 1fr);
  align-items: start;
  gap: var(--space-4);
}

@media (max-width: 1100px) {
  .map-layout {
    grid-template-columns: minmax(0, 1fr);
  }
}

.map-panel {
  min-width: 0;
}

.map-panel__hint {
  font-size: 11.5px;
  margin: 0;
}

.map-canvas {
  width: 100%;
  height: auto;
  max-height: 62vh;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
}

.map-canvas__bg {
  fill: var(--color-bg-subtle);
}

.map-grid line {
  stroke: var(--color-border);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}

.map-marker {
  cursor: pointer;
}

.map-marker__dot {
  fill: var(--color-accent-soft);
  stroke: var(--color-accent);
  stroke-width: 2;
}

.map-marker--active .map-marker__dot {
  fill: var(--color-accent);
}

.map-marker__label {
  font-size: 11px;
  fill: var(--color-text);
}

.map-missing {
  margin-top: var(--space-3);
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-2);
}

.map-missing__title,
.map-missing__hint {
  font-size: 11.5px;
  margin: 0;
}

.map-missing__list {
  margin: 4px 0;
  padding-left: 18px;
  font-size: 12.5px;
}

.map-side {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-width: 0;
}

.map-side__sub {
  margin-top: var(--space-2);
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-2);
}

.map-alarms {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  overflow: auto;
}

.map-alarms__item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.map-alarms__item:hover {
  border-color: var(--color-border-strong);
}

.map-alarms__item--active {
  border-color: var(--color-accent);
  background: var(--color-accent-soft);
}

.map-alarms__time {
  flex: 1;
  min-width: 0;
}

.map-alarms__value {
  font-variant-numeric: tabular-nums;
}

.map-snapshots {
  border-top: 1px solid var(--color-border);
  padding-top: var(--space-2);
}

.map-snapshots__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: var(--space-2);
}

.map-snapshots__grid figure {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.map-snapshots__grid img {
  width: 100%;
  height: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-subtle);
}

.map-snapshots__grid figcaption {
  font-size: 11px;
}
</style>

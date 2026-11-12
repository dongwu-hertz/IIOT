<script setup lang="ts">
/**
 * 设备归属与属性的只读卡片（业主 2026-11-12）。
 *
 * 录入在设备管理页的「编辑」对话框里（与安装信息同一处），这里只在设备详情概览里
 * 显示录过什么。空值显示「无 / 尚未添加属性」，不显示 0 或空白行。
 */
import { useI18n } from 'vue-i18n'
import type { DeviceAttribute } from '@shared/domain/models'

defineProps<{
  department?: string
  attributes?: DeviceAttribute[]
}>()

const { t } = useI18n()
</script>

<template>
  <section class="card device-profile-card" data-device-profile>
    <div class="section-header">
      <h3 class="section-title">{{ t('devicesUi.profileSection') }}</h3>
    </div>
    <dl class="kv">
      <div class="kv__item">
        <dt class="kv__label">{{ t('devicesUi.department') }}</dt>
        <dd class="kv__value" data-device-profile-department>
          {{ department && department.trim() !== '' ? department : t('common.none') }}
        </dd>
      </div>
      <div class="kv__item">
        <dt class="kv__label">{{ t('devicesUi.attributes') }}</dt>
        <dd class="kv__value">
          <ul v-if="attributes && attributes.length > 0" class="device-profile__attributes" data-device-profile-attributes>
            <li v-for="attribute in attributes" :key="attribute.key">
              <span class="mono">{{ attribute.key }}</span>
              <span class="muted">=</span>
              <span>{{ attribute.value }}</span>
            </li>
          </ul>
          <span v-else class="muted">{{ t('devicesUi.noAttributes') }}</span>
        </dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.device-profile__attributes {
  margin: 0;
  padding-left: 1.1em;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
</style>

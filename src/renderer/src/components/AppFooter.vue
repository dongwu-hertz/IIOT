<script setup lang="ts">
/**
 * 应用页脚（产品要求：「版权信息，公司信息，不用保留邮箱，下面就是版权信息和版本信息
 * 以及发布日期，居中对齐」）。
 *
 * 一行、居中：版权 · 公司网站 · 版本号 · 发布日期。
 *
 * 这一条**推翻了上一轮的分栏做法**。上一轮把页脚拆成左右两半 —— 左边「这是谁做的」
 * （版权 · 网站 · 支持邮箱），右边「这是哪一版」（版本号 · 发布日期），中间用一个
 * `.app-footer__spacer` 把右半边推到最右。产品负责人这一轮明确了两件事：
 *   1. **不要邮箱**（公司信息里只留网站链接，邮箱从页脚去掉）；
 *   2. 整个页脚**居中**，不留那个把内容分成两半的弹性空隙。
 * 所以 `__spacer` 已经删除，`justify-content: center` 是这一行唯一的对齐来源；
 * 再放回一个 `flex: 1` 的空元素就会重新把右半边推走，`tests/app-footer.test.ts`
 * 钉住了这一点，`scripts/demo-shot-driver.cjs` 在真实窗口里量中心线。
 *
 * 为什么是 `app-main` 的子元素，而不是 `.app-content` 的：
 * 内容区是滚动容器，页脚挂在它里面就会跟着内容一起滚走——「页脚」的意思正是
 * 它一直在底部。所以它和 `.app-content` 平级，由外层 flex 布局把它按在底部。
 *
 * 版本来自 `settings.appInfo`（主进程读 package.json，与安装包同一个值），
 * 与「关于」面板走同一条数据流，所以两处永远说同一句话。
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RELEASE, formatVersion, parsePlainDate } from '@shared/release'
import { useSettingsStore } from '@renderer/stores/settings'
import { resultMessage } from '@renderer/lib/result'
import { formatDate } from '@renderer/i18n'

const { t } = useI18n()
const settings = useSettingsStore()

const versionText = computed(() =>
  settings.appInfo?.version ? formatVersion(settings.appInfo.version) : t('app.versionFallback')
)

/**
 * 发布日期按**当前语言**格式化。
 *
 * 与侧栏旧版页脚同一理由：共享层曾经有一个只写中文 `2026 年 9 月 11 日` 的
 * `formatReleaseDate`，在英/西/土界面里是错的。`parsePlainDate` + Intl 版
 * `formatDate` 知道西语写 `11 sept 2026`、土语写 `11 Eyl 2026`，并且会在切换语言后
 * 重新求值，所以换语言不需要刷新。
 */
const releaseText = computed(() => {
  const parsed = parsePlainDate(settings.appInfo?.releaseDate)
  return parsed ? formatDate(parsed.getTime()) : ''
})

/**
 * 版权年份。
 *
 * 取**发布日期**的年份而不是 `new Date().getFullYear()`：版权声明的主语是那个
 * 发布的制品，写一个"运行时的年份"会让 2026 年发布的版本在 2027 年的机器上显示
 * 成 2027——一句关于构建时间的话变成了关于当前时间的话。没有发布日期时才退回当前年。
 */
const copyrightYear = computed(() => {
  const parsed = parsePlainDate(settings.appInfo?.releaseDate)
  return String((parsed ?? new Date()).getFullYear())
})

/**
 * 用系统处理器打开链接。
 *
 * 渲染层的 CSP 会拦掉外部跳转，所以走主进程——主进程会校验协议，畸形地址在这里
 * 是「失败关闭」而不是把任意协议交给操作系统。
 */
async function openLink(url: string): Promise<void> {
  const result = await window.api.app.openExternal(url)
  if (!result.success) settings.setError?.(resultMessage(result))
}

onMounted(() => {
  if (!settings.appInfo && !settings.loading) void settings.load()
})
</script>

<template>
  <footer class="app-footer">
    <span class="app-footer__copyright">
      {{ t('app.footerCopyright', { year: copyrightYear }) }}
    </span>
    <span class="app-footer__sep" aria-hidden="true">·</span>
    <button type="button" class="app-footer__link" @click="openLink(RELEASE.homepage)">
      {{ RELEASE.homepage.replace(/^https?:\/\//, '') }}
    </button>
    <span class="app-footer__sep" aria-hidden="true">·</span>
    <span class="app-footer__version">{{ versionText }}</span>
    <template v-if="releaseText">
      <span class="app-footer__sep" aria-hidden="true">·</span>
      <span class="app-footer__version">{{ releaseText }}</span>
    </template>
  </footer>
</template>

<style scoped>
/*
 * 一整行居中：`justify-content: center` 把整条内容按中心线摆好。原来这里靠
 * `__spacer`（`flex: 1 1 auto`）把版本号那一半推到最右，那个元素已经删除 ——
 * 产品这一轮要的就是居中，任何 `flex: 1` 的空元素都会立刻破坏它。
 * 居中量的是**内容块的中心**与容器中心之差，见 `scripts/demo-shot-driver.cjs`。
 */
.app-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 18px;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-subtle);
  color: var(--color-text-secondary);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
}

.app-footer__copyright {
  flex: none;
}

.app-footer__sep {
  flex: none;
  color: var(--color-border-strong);
}

.app-footer__version {
  flex: none;
}

.app-footer__link {
  /* 用 button 而不是 a：CSP 禁掉渲染层的外部跳转，点击必须经过主进程。
     样式做成链接的样子，但保留按钮的键盘与焦点行为。 */
  all: unset;
  flex: none;
  cursor: pointer;
  border-radius: 3px;
}

.app-footer__link:hover,
.app-footer__link:focus-visible {
  color: var(--color-accent);
  text-decoration: underline;
}
</style>

/**
 * 页脚（产品要求：「版权信息，公司信息，不用保留邮箱，下面就是版权信息和版本信息以及
 * 发布日期，居中对齐。」，负责人进一步确认：**保留网站链接，只去掉邮箱**）。
 *
 * WHY THIS FILE EXISTS
 * 页脚这一轮同时改了三件事，而三件事都能在源码里「看起来对」而屏幕上不对：
 *   1. 邮箱要真的不在（它可能是从主进程的 release 元数据里带回来的，删了模板里的
 *      按钮、留着 `RELEASE.supportEmail` 一样会把地址渲染出来）；
 *   2. 整条内容要居中 —— 上一轮是「版权 · 网站 · 邮箱」＋一个 `flex: 1` 的
 *      `.app-footer__spacer`＋「版本 · 发布日」，右半边被那个空隙推到最右；
 *      只要那个元素回来，居中立刻失效，而左右留白仍然相等（都是内边距），肉眼和
 *      「左右留白相等」这种弱断言都看不出来；
 *   3. 网站链接还在。
 * 真机上的证据（页脚文字、内容块中心与容器中心之差、相邻子元素最大空隙、点击链接后
 * 主进程真的收到 `shell.openExternal`）在 `scripts/demo-shot-driver.cjs`；这里钉源码。
 *
 * 中文注释是仓库约定（见 `tests/channel-state.test.ts`）。
 */

import { strict as assert } from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const projectRoot = path.resolve(__dirname, '..', '..')

function read(relative: string): string {
  return fs.readFileSync(path.join(projectRoot, relative), 'utf8')
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function styleBlock(source: string): string {
  const match = /<style[^>]*>([\s\S]*?)<\/style>/.exec(source)
  assert.ok(match, '组件里没有 <style> 块')
  return stripCssComments(match[1] ?? '')
}

function templateBlock(source: string): string {
  const start = source.indexOf('<template>')
  const end = source.lastIndexOf('</template>')
  assert.ok(start >= 0 && end > start, '组件里没有 <template> 块')
  return source.slice(start, end)
}

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  assert.ok(start >= 0, `没有找到规则 ${selector}`)
  const end = css.indexOf('}', start)
  assert.ok(end > start, `规则 ${selector} 没有闭合`)
  return css.slice(start, end)
}

const footer = read('src/renderer/src/components/AppFooter.vue')
const template = templateBlock(footer)
const css = styleBlock(footer)

describe('页脚：不要邮箱', () => {
  it('模板里没有邮箱：没有 supportEmail、没有 mailto:', () => {
    assert.equal(template.includes('supportEmail'), false, '模板仍然引用 RELEASE.supportEmail')
    assert.equal(/mailto:/i.test(template), false, '模板里仍然有 mailto: 链接')
    // 硬编码的邮箱地址（`xx@yy.zz`）也算：`@click` 这类指令不会被这个正则命中，
    // 因为它要求 @ 前面有地址字符、后面有点分域名。
    const email = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(template)
    assert.equal(email, null, `页脚里出现了邮箱地址：${email?.[0] ?? ''}`)
  })

  it('页脚只留下一处外部打开（网站链接），邮箱按钮不会再被加回来', () => {
    // `openLink` 在脚本里定义一次、在模板里调用一次；多一次调用就意味着页脚里多了一个
    // 外部链接（上一轮那个就是邮箱）。
    const calls = footer.match(/openLink\(/g) ?? []
    assert.equal(calls.length, 2, `openLink 出现 ${calls.length} 次，期望「定义 1 + 调用 1」`)
    assert.match(template, /@click="openLink\(RELEASE\.homepage\)"/)
  })
})

describe('页脚：整条内容居中', () => {
  it('居中来自 justify-content: center，而且没有把内容分成两半的 spacer', () => {
    const rule = ruleBody(css, '.app-footer')
    assert.match(rule, /justify-content:\s*center/)
    // 上一轮的 `__spacer`（flex: 1）是把右半边推到最右的那件东西，它必须不在。
    assert.equal(css.includes('app-footer__spacer'), false, '样式里又出现了 .app-footer__spacer')
    assert.equal(template.includes('app-footer__spacer'), false, '模板里又出现了 .app-footer__spacer')
  })

  it('页脚里没有任何会撑开空白的弹性元素（它们会把内容推成左右两半）', () => {
    for (const rule of css.matchAll(/\.app-footer[^{]*\{([^}]*)\}/g)) {
      const body = rule[1] ?? ''
      assert.equal(
        /flex:\s*1/.test(body),
        false,
        `页脚里出现了 flex: 1（会撑开空隙，居中失效）：${rule[0]}`
      )
    }
  })

  it('版权、版本、发布日期三样都还在模板里', () => {
    assert.match(template, /t\('app\.footerCopyright', \{ year: copyrightYear \}\)/)
    assert.match(template, /\{\{ versionText \}\}/)
    assert.match(template, /\{\{ releaseText \}\}/)
    // 发布日期按当前语言格式化：日期是数据，不是中文文案（四语言切换必须跟着变）。
    assert.match(footer, /formatDate\(parsed\.getTime\(\)\)/)
  })
})

describe('页脚用的词条在四种语言里都存在', () => {
  /**
   * 四种语言各一份目录（与 `tests/camera-wall.test.ts` 的读法一致）。
   *
   * 这里只查页脚真正用到的那一条：键被删掉、界面就会渲染出一串裸 key，而那是在
   * 页脚上、在每一个页面上。**本文件不修改目录**（目录由另一轮负责）。
   */
  const catalogues: Record<string, string> = {
    'zh-CN': 'src/shared/i18n/messages/zh-CN.ts',
    en: 'src/shared/i18n/messages/en.ts',
    es: 'src/shared/i18n/messages/es.ts',
    tr: 'src/shared/i18n/messages/tr.ts'
  }

  it('app.footerCopyright 在四种语言里都有 {year} 占位符', () => {
    for (const [locale, file] of Object.entries(catalogues)) {
      const source = read(file)
      const line = /footerCopyright:\s*'([^']*)'/.exec(source)
      assert.ok(line, `${locale} 的目录里没有 footerCopyright`)
      assert.ok(
        (line[1] ?? '').includes('{year}'),
        `${locale} 的 footerCopyright 丢了 {year} 占位符：${line[1] ?? ''}`
      )
    }
  })
})

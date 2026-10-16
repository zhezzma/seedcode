// node:test 风格：纯解析函数真跑，DOM 触发用 document stub 捕获锚点属性与 click，
// 组件侧用源码结构断言锁契约（Vue 组件无法在 node:test 里 import）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { parseExternalUrl, openExternalLink } from '../src/utils/external-link.ts'

const root = path.resolve(import.meta.dirname, '..')
const utilSource = readFileSync(path.join(root, 'src/utils/external-link.ts'), 'utf8')
const switcherSource = readFileSync(path.join(root, 'src/components/GatewaySwitcher.vue'), 'utf8')

// 断言"代码里不出现某写法"时必须先去注释：注释里会点名这些反面模式（说明为何不用）。
// HTML 注释（Vue 模板）一并剥掉；(^|[^:])  guard 防误伤字符串里的 "://"。
const stripComments = (src: string) => src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const utilCode = stripComments(utilSource)
const switcherCode = stripComments(switcherSource)

test('parseExternalUrl: 仅放行 http(s)，其余 scheme 与非法输入拒绝', () => {
    assert.equal(parseExternalUrl('http://example.com')?.href, 'http://example.com/')
    assert.equal(parseExternalUrl('  https://example.com/a?b=c  ')?.href, 'https://example.com/a?b=c')
    assert.equal(parseExternalUrl('javascript:alert(1)'), null)
    assert.equal(parseExternalUrl('data:text/html,<b>x</b>'), null)
    assert.equal(parseExternalUrl('mailto:a@b.c'), null)
    assert.equal(parseExternalUrl('file:///etc/hosts'), null)
    assert.equal(parseExternalUrl('not a url'), null)
    assert.equal(parseExternalUrl(''), null)
})

test('openExternalLink: JS 触发一次性 <a target="_blank">，非法地址不触发', () => {
    const clicked: Array<{ href: string, target: string, rel: string }> = []
    const originalDocument = (globalThis as any).document
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: {
            createElement: () => ({
                href: '',
                target: '',
                rel: '',
                click(this: { href: string, target: string, rel: string }) {
                    clicked.push({ href: this.href, target: this.target, rel: this.rel })
                },
                remove() { },
            }),
            body: { appendChild() { }, removeChild() { } },
        },
    })

    try {
        assert.equal(openExternalLink('https://example.com'), true)
        assert.equal(openExternalLink('javascript:alert(1)'), false)
        assert.equal(openExternalLink('not a url'), false)
    } finally {
        Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
    }

    assert.deepEqual(clicked, [{ href: 'https://example.com', target: '_blank', rel: 'noopener noreferrer' }])
})

test('账号菜单外部链接：子菜单行 button + JS 触发锚点，不引插件不用 window.open', () => {
    // 子面板链接行是 button（先关菜单再触发，关菜单不拦导航），不是自带 target=_blank 的 <a>；
    // 行点击统一走 openLink(link)：先 closeMenu（发 navigate 收尾抽屉），再经 openExternalLink 触发锚点
    assert.match(
        switcherSource,
        /@click="openLink\(link\)"/,
        'external link submenu rows must be buttons wired to openLink(link)',
    )
    assert.match(
        switcherSource,
        /const openLink = \(link: ExternalLinkItem\) => \{\s*closeMenu\(\)\s*openExternalLink\(link\.url\)/,
        'openLink must close the menu first, then trigger the anchor via openExternalLink',
    )
    assert.match(switcherSource, /from ['"]\.\.\/utils\/external-link(?:\.ts)?['"]/)
    assert.match(switcherSource, /openExternalLink\(link\.url\)/)
    // 打开路径只有一条：JS 触发原生锚点。禁 window.open 与 opener 插件（剥注释后断言）
    assert.doesNotMatch(utilCode, /window\.open/)
    assert.doesNotMatch(utilCode, /plugin-opener/)
    assert.doesNotMatch(switcherCode, /window\.open/)
    assert.doesNotMatch(switcherCode, /plugin-opener/)
})

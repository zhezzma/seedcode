import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import zhMessages from '../src/i18n/zh.ts'
import enMessages from '../src/i18n/en.ts'

// 源码结构断言（仓库惯例）：Vue 组件无法在 node:test 里 import，用正则锁定契约。
// 本文件覆盖「外部链接」功能的重构契约：
// 1) 本地单一 externalUrl 设置整体移除（store/设置页/i18n），旧键从持久化配置中剥离；
// 2) 侧边栏悬浮菜单是服务端 external-links 扩展数据的只读展示（懒加载端点 + 点击打开）。

const root = path.resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(path.join(root, p), 'utf8')
const switcherSource = read('src/components/GatewaySwitcher.vue')
const settingsSource = read('src/views/SettingsView.vue')
const storeSource = read('src/stores/setting.ts')
const externalLinkSource = read('src/utils/external-link.ts')

/** 按点分路径查消息对象；任一层缺失/非对象即 false（同 i18n-keys.test.ts） */
function hasPath(messages: Record<string, unknown>, key: string): boolean {
    let node: unknown = messages
    for (const part of key.split('.')) {
        if (typeof node !== 'object' || node === null || !(part in (node as Record<string, unknown>))) {
            return false
        }
        node = (node as Record<string, unknown>)[part]
    }
    return true
}

test('UiSettings.externalUrl is fully removed from the local settings model', () => {
    // 字段声明与默认值必须消失（迁移剥离用的 delete parsed.externalUrl 除外，由下一条专测）
    assert.doesNotMatch(storeSource, /externalUrl\s*:\s*string/, 'setting.ts must drop the externalUrl field declaration')
    assert.doesNotMatch(storeSource, /externalUrl\s*:\s*''/, 'setting.ts must drop the externalUrl default')
    assert.doesNotMatch(settingsSource, /externalUrl/, 'SettingsView must drop the externalUrl row and its save handler')
})

test('legacy externalUrl key is stripped from persisted config on load', () => {
    // 与 lastActiveSessionKey/deviceName 同一迁移惯例：不剥离会随 ...parsed 流入
    // state 被反复回写，成为永远删不掉的死键
    assert.match(storeSource, /delete parsed\.externalUrl/)
})

test('settings.externalUrl i18n keys are gone, gateway.externalLink survives', () => {
    for (const [name, messages] of [['zh', zhMessages], ['en', enMessages]] as const) {
        const settingsSection = messages.settings as Record<string, unknown> | undefined
        assert.ok(settingsSection, `${name}.settings section must exist`)
        assert.equal('externalUrl' in (settingsSection ?? {}), false, `${name}.settings.externalUrl must be removed`)
        assert.equal('externalUrlPlaceholder' in (settingsSection ?? {}), false, `${name}.settings.externalUrlPlaceholder must be removed`)
        assert.equal('externalUrlDesc' in (settingsSection ?? {}), false, `${name}.settings.externalUrlDesc must be removed`)
        assert.equal(hasPath(messages, 'gateway.externalLink'), true, `${name}.gateway.externalLink is still the menu item label`)
    }
})

test('sidebar submenu renders server extension links read-only', () => {
    // 数据源：服务端 external-links 扩展（懒加载，菜单打开时拉取）
    assert.match(
        switcherSource,
        /\/api\/extensions\/external-links\/links/,
        'GatewaySwitcher must load links from the server extension endpoint',
    )
    // 只读展示：点击行经 openExternalLink 打开（不允许本地增删 UI）
    assert.match(
        switcherSource,
        /openExternalLink\(/,
        'submenu rows must open via the shared openExternalLink util',
    )
    assert.doesNotMatch(switcherSource, /configStore\.externalUrl/, 'switcher must not read the removed local setting')
    // 竞态守卫：跨网关切换/快速开关时，旧服务器的迟响应不得覆盖当前列表（请求序号闸）
    assert.match(
        switcherSource,
        /linksRequestSeq/,
        'lazy link fetches must be guarded against stale-response overwrites',
    )
})

test('touch devices are not swallowed by the hover-open + click-toggle race', () => {
    // 触屏点按会先派发兼容性 mouseenter（子面板被打开），随后的 click 若再做 toggle
    // 就会把首次点按吞掉（评审 Important #3）。非 hover 设备上 click 必须固定为「打开」
    // 语义（幂等），关闭交给点外/Esc/关菜单。
    assert.match(
        switcherSource,
        /matchMedia\?\.\(['"]\(hover: hover\)['"]\)/,
        'switcher must detect hover capability instead of assuming mouse',
    )
    assert.match(
        switcherSource,
        /const toggleLinksSubmenu = \(\) => \{[\s\S]*?if \(!canHover\) \{[\s\S]*?openLinksSubmenu\(\)/,
        'on non-hover devices click must be an idempotent open, never a toggle-close',
    )
})

test('settings form dialog applies updateComponents from rpc responses', () => {
    // 表单型 rpc（external-links 增删卡片）：服务端重生成整树回推，弹层必须就地
    // 换树（原先丢弃并告警——新卡片要关窗重开才出现，交互不可用）
    const dialogSource = read('src/components/extensions/A2UIFormDialog.vue')
    assert.match(
        dialogSource,
        /message\.updateComponents && message\.updateComponents\.surfaceId === formSurfaceId/,
        'form dialog must apply updateComponents responses instead of dropping them',
    )
    assert.match(
        dialogSource,
        /components\.value = message\.updateComponents\.components/,
        'form dialog must replace the component tree in place',
    )
})

test('external-link util comment reflects the new data source', () => {
    // utils/external-link.ts 的闸门注释引用了旧设置字段，重定向后应同步
    assert.doesNotMatch(externalLinkSource, /externalUrl 是设置里手填的值/)
})

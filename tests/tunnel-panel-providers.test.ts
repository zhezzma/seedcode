import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import zhMessages from '../src/i18n/zh.ts'
import enMessages from '../src/i18n/en.ts'

// TunnelPanel 是 .vue SFC，node:test 环境无法直接挂载；
// 沿用本仓库「源码契约测试」模式：对源码文本断言关键结构。
// 本文件锁定 tab 化重写后的新契约：
//   - 一个 tab 栏（局域网 + 元数据数组驱动 provider tabs），内容区单一共享区块——
//     每 tab 一张同构「连接卡」，禁止三份近似复制粘贴；
//   - per-provider rev 守卫（stateRev[id]）与全局轮询不随 tab 切换停摆；
//   - 状态徽标/圆点映射收敛到 tunnel-panel-model 单一来源（圆点含请求窗）；
//   - 局域网 IP 选中态归面板层（跨 tab 往返不丢）；
//   - 二维码 hash 协议 `${url}/#token=<token>`；
//   - 未配置 provider 显示指引；
//   - i18n zh/en tunnel 段逐键对齐。
const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')
const read = (p: string) => readFileSync(path.join(repoRoot, p), 'utf8')
const panel = read('src/components/extensions/panels/TunnelPanel.vue')
const section = read('src/components/extensions/panels/TunnelProviderSection.vue')
const lanSection = read('src/components/extensions/panels/TunnelLanSection.vue')
const model = read('src/components/extensions/panels/tunnel-panel-model.ts')

test('一个 tab 栏：局域网 + 元数据数组驱动 provider tabs，内容区单一共享区块', () => {
    // 展示顺序唯一事实源：ssh/devbridge/cloudflare
    assert.match(model,
        /export const TUNNEL_PROVIDER_IDS = \['ssh', 'devbridge', 'cloudflare'\] as const/)
    assert.match(model, /export type TunnelTabId = 'lan' \| TunnelProviderId/)

    // tab 栏：provider tabs 由元数据数组驱动（局域网 tab 常驻首位）；
    // daisyUI 5 类名 tabs-border（v4 旧名已弃用，用错下划线指示条不渲染）
    assert.match(panel, /<div role="tablist" class="tabs tabs-border tabs-sm justify-center mb-4">/)
    assert.doesNotMatch(panel, /tabs-bordered/)
    assert.match(panel,
        /<button v-for="id in TUNNEL_PROVIDER_IDS" :key="id" type="button" role="tab" class="tab gap-1\.5"/)
    // tab 短标签（品牌名，语言无关）收敛在 model：完整 label 在四联 tab 里会折行
    assert.match(model, /export const TUNNEL_PROVIDER_TAB_LABELS: Record<TunnelProviderId, string>/)
    assert.match(panel, /\{\{ TUNNEL_PROVIDER_TAB_LABELS\[id\] \}\}/)

    // 内容区：每个区块组件只出现一次（绑定当前选中 tab），禁止每 provider 一份近似模板块
    assert.equal(panel.match(/<TunnelProviderSection/g)?.length, 1,
        'TunnelProviderSection must be referenced exactly once, not copy-pasted per provider')
    assert.match(panel, /<TunnelLanSection v-if="selected === 'lan'"/)
    assert.match(panel, /<TunnelProviderSection v-else :key="selected"/)

    // 旧结构不复存在：竖排列表容器 / 单远程视图残留
    assert.doesNotMatch(panel, /remoteTitle|selectedView|remotePill/)
    assert.doesNotMatch(panel, /<TunnelProviderSection v-for=/)
})

test('tab 状态圆点与区块徽标同源：映射收敛到 tunnel-panel-model（圆点含请求窗）', () => {
    // 单一映射来源（badge 供区块、dot 供 tab 栏），杜绝两处各自 switch 漂移
    assert.match(model, /export function providerBadgeClass\(/)
    assert.match(model, /export function providerDotClass\(/)
    assert.match(section, /providerBadgeClass\(props\.state, props\.starting, props\.stopping\)/)
    assert.match(panel, /providerDotClass\(providerState\(id\), !!starting\[id\], !!stopping\[id\]\)/)
    // 圆点含请求窗：否则点击连接的瞬间圆点比区块徽标滞后一拍
    assert.match(model, /if \(starting\) return 'bg-info animate-pulse'/)
    // section 内不得再有自己的徽标 switch（防漂移）
    assert.doesNotMatch(section, /case 'ready': return 'badge-success'/)
})

test('per-provider rev 守卫：stateRev[id]，在途轮询不覆盖权威结果；轮询不随 tab 切换停摆', () => {
    // per-provider 版本号簿记 + bump 助手
    assert.match(panel, /const stateRev: Record<string, number> = \{\}/)
    assert.match(panel, /const bumpRev = \(id: string\) => \{/)

    // 轮询响应按 provider 快照合并：rev 变化的 provider 保留上一帧（不被过期快照覆盖）
    const mergeBlock = panel.match(/for \(const id of ids\) \{[\s\S]*?\n        \}/)?.[0] ?? ''
    assert.ok(mergeBlock, 'per-provider merge loop should exist in refreshState')
    assert.match(mergeBlock, /const stale = \(revSnapshot\[id\] \?\? 0\) !== \(stateRev\[id\] \?\? 0\)/)
    assert.match(mergeBlock, /stale\s*\?\s*prev\?\.providers\[id\]/)

    // start/stop 双 bump：POST 前使在途轮询失效，写入权威结果后再失效一轮
    assert.match(panel, /busy\[id\] = true\s*\n\s+bumpRev\(id\)/)
    assert.match(panel, /bumpRev\(id\)\s*\n\s+state\.value = \{/)

    // 轮询对全部 provider 持续进行（tab 圆点才能实时），onMounted 即启动
    assert.match(panel, /void refreshState\(false\)/)
    assert.match(panel, /schedulePoll\(\)/)
})

test('二维码 hash 协议：`${url}/#token=<token>`（与局域网直连同一 tunnel-hash 引导）', () => {
    // provider 区块（远程）与局域网区块均用 encodeURIComponent 包裹 token
    assert.match(section, /`\$\{url\}\/#token=\$\{encodeURIComponent\(token\)\}`/)
    assert.match(lanSection, /\/#token=\$\{encodeURIComponent\(tok\)\}/)

    // 二维码时序守护各自持有：await 期间地址变化时旧码不得写入
    assert.match(section, /if \(shareUrl\.value === text\) qrDataUrl\.value = dataUrl/)
    assert.match(lanSection, /if \(lanShareUrl\.value === text\) qrDataUrl\.value = dataUrl/)
})

test('未就绪不渲染空二维码：二维码区块以分享链接存在为门', () => {
    // shareUrl/lanShareUrl 为 null（未就绪/无令牌/无地址）时整块二维码+链接+复制按钮都不渲染：
    // 不得留一个 src="" 的空二维码占位，那会让用户以为「已就绪但码没出来」
    assert.match(section, /<template v-if="shareUrl">/)
    assert.match(lanSection, /<template v-if="lanShareUrl">/)
})

test('未配置 provider：显示指引文案（去对应设置页），连接控件隐藏', () => {
    // configured=false → 指引分支渲染，主控制体（template v-else-if="state"）不渲染
    assert.match(section, /const unconfigured = computed\(\(\) => !!props\.state && !props\.state\.configured\)/)
    assert.match(section, /<p v-if="unconfigured" class="text-xs text-warning mt-2">/)
    assert.match(section, /\{\{ t\(`\$\{prefix\}\.unconfigured`\) \}\}/)
    // 指引与控制体互斥（v-if / v-else-if 链）
    assert.match(section, /<template v-else-if="state">/)
})

test('共享区块的状态/文案差异全部收敛到 provider 前缀 i18n 键', () => {
    assert.match(section, /const prefix = computed\(\(\) => `extensions\.tunnel\.providers\.\$\{props\.providerId\}`\)/)
    assert.match(section, /`\$\{prefix\.value\}\.starting`/)
    assert.match(section, /`\$\{prefix\.value\}\.ready`/)
    assert.match(section, /`\$\{prefix\}\.hint`/)
    assert.match(section, /`\$\{prefix\}\.verifyFailed`/)
    assert.match(section, /`\$\{prefix\}\.reconnecting`, \{ n: state\.pendingReconnect \}\)/)
})

test('局域网直连区块：独立 Section 组件，IP 选中态归面板层（跨 tab 往返不丢）', () => {
    // 选中态上提面板层：切换 provider tab 再回来，用户显式选择的网卡不丢失
    assert.match(panel, /const selectedLanIp = ref\(''\)/)
    assert.match(panel, /:selected-ip="selectedLanIp"/)
    assert.match(panel, /@select="selectedLanIp = \$event"/)
    assert.match(panel, /!state\.value\.lanIps\.includes\(selectedLanIp\.value\)/)
    assert.doesNotMatch(lanSection, /const selectedLanIp = ref\(/)
    assert.match(lanSection, /selectedIp: string/)
    assert.match(lanSection, /function selectLan\(ip: string\)/)
    assert.match(lanSection, /@click="selectLan\(ip\)"/)

    // lanReady 引导行常驻（基线行为）：在 v-if 链之前渲染，首帧 state=null 也不空白
    assert.ok(lanSection.indexOf("t('extensions.tunnel.lanReady')") < lanSection.indexOf('v-if="state?.lanIps?.length'),
        'lanReady must render before the readiness v-if chain')

    // App 局域网地址不回落远程：appConnectUrl 只由局域网 IP/端口构成
    const appUrlBlock = lanSection.match(/const appConnectUrl = computed\(\(\) => \{[\s\S]*?\n\}\)/)?.[0] ?? ''
    assert.ok(appUrlBlock)
    assert.doesNotMatch(appUrlBlock, /providers/)
})

test('i18n：三 provider 前缀子树 zh/en 逐键对齐，废弃键已清理，tunnel 段键集一致', () => {
    const IDS = ['ssh', 'devbridge', 'cloudflare'] as const
    const KEYS = ['label', 'idle', 'starting', 'stopping', 'connecting', 'ready',
        'failed', 'reconnecting', 'unconfigured', 'hint', 'verifyFailed'] as const

    const tunnelOf = (msgs: Record<string, any>) =>
        (msgs as any).extensions?.tunnel as Record<string, any> | undefined
    const zhTunnel = tunnelOf(zhMessages)
    const enTunnel = tunnelOf(enMessages)
    assert.ok(zhTunnel, 'extensions.tunnel missing in zh.ts')
    assert.ok(enTunnel, 'extensions.tunnel missing in en.ts')

    for (const id of IDS) {
        for (const key of KEYS) {
            assert.ok(typeof zhTunnel.providers?.[id]?.[key] === 'string' && zhTunnel.providers[id][key] !== '',
                `zh extensions.tunnel.providers.${id}.${key} missing`)
            assert.ok(typeof enTunnel.providers?.[id]?.[key] === 'string' && enTunnel.providers[id][key] !== '',
                `en extensions.tunnel.providers.${id}.${key} missing`)
        }
        // label 本地化（任务书裁定：i18n 前缀键优先于后端 label）
        assert.match(zhTunnel.providers[id].label, /\S/)
        assert.notEqual(zhTunnel.providers[id].label, enTunnel.providers[id].label,
            `providers.${id}.label should be localized per language`)
    }

    // tab 栏新键：局域网 tab 标签双语齐备
    assert.ok(typeof zhTunnel.lanTab === 'string' && zhTunnel.lanTab.length > 0, 'zh lanTab missing')
    assert.ok(typeof enTunnel.lanTab === 'string' && enTunnel.lanTab.length > 0, 'en lanTab missing')

    // 废弃键清理：单远程视图时代与竖排列表时代的散键不再存在
    for (const key of ['idle', 'connecting', 'ready', 'failed', 'reconnecting', 'startHint', 'remotePill', 'remoteTitle']) {
        assert.equal(zhTunnel[key], undefined, `zh extensions.tunnel.${key} should be removed`)
        assert.equal(enTunnel[key], undefined, `en extensions.tunnel.${key} should be removed`)
    }

    // tunnel 段顶层键集 zh/en 整体一致（防单侧加键漂移）
    assert.deepEqual(Object.keys(zhTunnel).sort(), Object.keys(enTunnel).sort())
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import zhMessages from '../src/i18n/zh.ts'
import enMessages from '../src/i18n/en.ts'

// TunnelPanel 是 .vue SFC，node:test 环境无法直接挂载；
// 沿用本仓库「源码契约测试」模式：对源码文本断言关键结构。
// 本文件锁定多 provider 重写后的新契约：
//   - 远程视图列表化：元数据数组驱动 v-for，单一共享 TunnelProviderSection（零复制粘贴）；
//   - per-provider rev 守卫（stateRev[id]）；
//   - 二维码 hash 协议 `${url}/#token=<token>`；
//   - 未配置 provider 显示指引；
//   - i18n zh/en providers 前缀子树逐键对齐。
const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')
const read = (p: string) => readFileSync(path.join(repoRoot, p), 'utf8')
const panel = read('src/components/extensions/panels/TunnelPanel.vue')
const section = read('src/components/extensions/panels/TunnelProviderSection.vue')
const model = read('src/components/extensions/panels/tunnel-panel-model.ts')

test('远程视图列表化：元数据数组驱动 v-for，单一共享区块（零复制粘贴）', () => {
    // 展示顺序唯一事实源：ssh/devbridge/cloudflare
    assert.match(model,
        /export const TUNNEL_PROVIDER_IDS = \['ssh', 'devbridge', 'cloudflare'\] as const/)

    // 面板以元数据数组驱动 v-for 渲染共享区块
    assert.match(panel, /<TunnelProviderSection v-for="id in TUNNEL_PROVIDER_IDS"/)
    // 共享区块在面板模板中只出现一次：禁止三个 provider 各写一份近似模板块
    assert.equal(panel.match(/<TunnelProviderSection/g)?.length, 1,
        'TunnelProviderSection must be referenced exactly once (v-for), not copy-pasted per provider')

    // 旧单远程视图结构已移除：selectedView / remotePill / 远程视图回落 watch
    assert.doesNotMatch(panel, /selectedView/)
    assert.doesNotMatch(panel, /remotePill/)
    assert.doesNotMatch(section, /selectedView/)
})

test('per-provider rev 守卫：stateRev[id]，在途轮询不覆盖权威结果', () => {
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
})

test('二维码 hash 协议：`${url}/#token=<token>`（与局域网直连同一 tunnel-hash 引导）', () => {
    // provider 区块（远程）与面板（局域网）均用 encodeURIComponent 包裹 token
    assert.match(section, /`\$\{url\}\/#token=\$\{encodeURIComponent\(token\)\}`/)
    assert.match(panel, /\/#token=\$\{encodeURIComponent\(tok\)\}/)

    // 二维码时序守护各自持有：await 期间地址变化时旧码不得写入
    assert.match(section, /if \(shareUrl\.value === text\) qrDataUrl\.value = dataUrl/)
    assert.match(panel, /if \(lanShareUrl\.value === text\) qrDataUrl\.value = dataUrl/)
})

test('未就绪不渲染空二维码：二维码区块以分享链接存在为门（旧测试删时丢的锁）', () => {
    // shareUrl/lanShareUrl 为 null（未就绪/无令牌/无地址）时整块二维码+链接+复制按钮都不渲染：
    // 不得留一个 src="" 的空二维码占位，那会让用户以为「已就绪但码没出来」
    assert.match(section, /<template v-if="shareUrl">/)
    assert.match(panel, /<template v-if="lanShareUrl">/)
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

test('局域网直连视图不动：常驻二维码 + IP 切换 + App 局域网连接信息', () => {
    assert.match(panel, /const lanShareUrl = computed\(/)
    assert.match(panel, /function selectLan\(ip: string\)/)
    assert.match(panel, /@click="selectLan\(ip\)"/)
    assert.match(panel, /v-if="appConnectUrl && !tokenMissing"/)
    assert.match(panel, /\{\{ t\('extensions\.tunnel\.lanReady'\) \}\}/)
    // App 局域网地址不回落远程：appConnectUrl 只由局域网 IP/端口构成
    const appUrlBlock = panel.match(/const appConnectUrl = computed\(\(\) => \{[\s\S]*?\n\}\)/)?.[0] ?? ''
    assert.ok(appUrlBlock)
    assert.doesNotMatch(appUrlBlock, /providers/)
})

test('i18n：三 provider 前缀子树 zh/en 逐键对齐，废弃单远程键已清理', () => {
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

    // 废弃键清理：单远程视图时代的散键不再存在
    for (const key of ['idle', 'connecting', 'ready', 'failed', 'reconnecting', 'startHint', 'remotePill']) {
        assert.equal(zhTunnel[key], undefined, `zh extensions.tunnel.${key} should be removed`)
        assert.equal(enTunnel[key], undefined, `en extensions.tunnel.${key} should be removed`)
    }
})

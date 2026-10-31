import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { parseTunnelHash, applyTunnelBootstrap, stripHashFromUrl } from '../src/utils/tunnel-hash.ts'
import { useUiSettingsStore } from '../src/stores/setting.ts'

const root = path.resolve(import.meta.dirname, '..')

test.beforeEach(() => {
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => storage.set(key, value),
            removeItem: (key: string) => storage.delete(key),
        },
    })
    setActivePinia(createPinia())
})

test('parseTunnelHash extracts token from #token=...', () => {
    assert.deepEqual(parseTunnelHash('#token=abc123'), { token: 'abc123' })
    assert.deepEqual(parseTunnelHash('#foo=1&token=xyz'), { token: 'xyz' })
    // token 前后空白裁剪
    assert.deepEqual(parseTunnelHash('#token=%20%20pw%20'), { token: 'pw' })
    // 白名单收紧后的新语义（与 gateway-qr 的 isValidShareToken 同一实现）：
    // 内含空格不在可打印 ASCII（0x21-0x7e）白名单内——典型的链接被改坏（+ 未编码）产物，整单拒收
    assert.equal(parseTunnelHash('#token=abc%20123'), null)
})

test('parseTunnelHash rejects tokens outside the shared printable-ASCII whitelist', () => {
    // 非 Latin-1 / C1 控制区令牌会让 Authorization 头构造 TypeError（该网关全站「网络错误」）：
    // 坏链接整体作废（null）→ main.ts 不引导入、不写 settings
    assert.equal(parseTunnelHash('#token=%E4%BB%A4'), null)
    assert.equal(parseTunnelHash('#token=abc%C2%85'), null)
    // 控制字符放在中间：首尾会被 trim 抹掉（#token=abc%0A 等价于 abc，仍属合法令牌）
    assert.equal(parseTunnelHash('#token=a%0Ab'), null)
})

test('parseTunnelHash returns null for missing/empty token or non-hash input', () => {
    assert.equal(parseTunnelHash(''), null)
    assert.equal(parseTunnelHash('token=abc'), null) // 缺 # 前缀
    assert.equal(parseTunnelHash('#'), null)
    assert.equal(parseTunnelHash('#other=1'), null)
    assert.equal(parseTunnelHash('#token='), null)
    assert.equal(parseTunnelHash('#token=%20%20'), null)
})

test('applyTunnelBootstrap upserts an activated same-origin remote gateway entry', () => {
    const settings = useUiSettingsStore()
    settings.apiBaseUrl = ''
    settings.token = ''
    settings.setupDone = false

    applyTunnelBootstrap(settings, 'http://159.138.99.139:18799', { token: 'sekret' })

    // 顶层生效值（api-client.getBaseUrl() 依赖 apiBaseUrl 非空，此处必须已可直连）
    assert.equal(settings.apiBaseUrl, 'http://159.138.99.139:18799')
    assert.equal(settings.token, 'sekret')
    assert.ok(settings.apiBaseUrl.trim() !== '')
    // 条目化：一条激活的 remote 网关，名称取 host 标签
    assert.equal(settings.gateways.length, 1)
    assert.equal(settings.gateways[0].type, 'remote')
    assert.equal(settings.gateways[0].apiBaseUrl, 'http://159.138.99.139:18799')
    assert.equal(settings.gateways[0].token, 'sekret')
    assert.equal(settings.gateways[0].name, '159.138.99.139:18799')
    assert.equal(settings.activeGatewayId, settings.gateways[0].id)
    assert.equal(settings.setupDone, true)
    // 落盘（localStorage）
    assert.match(globalThis.localStorage.getItem('openclaw_config') ?? '', /"token":"sekret"/)
})

test('applyTunnelBootstrap reuses the existing same-origin entry instead of duplicating', () => {
    const settings = useUiSettingsStore()
    const existing = settings.addGateway({ type: 'remote', name: 'vps', apiBaseUrl: 'http://159.138.99.139:18799/', token: 'old' })

    applyTunnelBootstrap(settings, 'http://159.138.99.139:18799', { token: 'sekret' })

    assert.equal(settings.gateways.length, 1, 'same-origin entry must be reused, not duplicated')
    assert.equal(settings.gateways[0].id, existing.id)
    assert.equal(settings.gateways[0].token, 'sekret')
    assert.equal(settings.activeGatewayId, existing.id)
    assert.equal(settings.token, 'sekret')
})

test('stripHashFromUrl removes hash while keeping path and search', () => {
    assert.equal(stripHashFromUrl('http://a.b:1/#token=x'), 'http://a.b:1/')
    assert.equal(stripHashFromUrl('http://a.b:1/chat/1?x=2#token=y&z=1'), 'http://a.b:1/chat/1?x=2')
    assert.equal(stripHashFromUrl('http://a.b:1/'), 'http://a.b:1/')
})

test('main.ts wires the hash bootstrap before router and mount (source contract)', () => {
    const source = readFileSync(path.join(root, 'src/main.ts'), 'utf8')
    assert.match(source, /parseTunnelHash\(window\.location\.hash\)/)
    assert.match(source, /applyTunnelBootstrap\(useUiSettingsStore\(\), window\.location\.origin/)
    assert.match(source, /history\.replaceState\(null, '', stripHashFromUrl\(window\.location\.href\)\)/)
    // Tauri 客户端（桌面/Android）不执行引导：origin 是伪协议，会写坏 apiBaseUrl
    assert.match(source, /!isTauri\s*\?\s*parseTunnelHash/)
    assert.match(source, /import \{ isTauri \} from '.\/composables\/notify-server-connection'/)
    // 引导必须先于 router 装载与 mount（顺序契约：indexOf 比较）
    const bootstrapPos = source.indexOf('applyTunnelBootstrap(useUiSettingsStore()')
    const routerPos = source.indexOf("app.use(router)")
    const mountPos = source.indexOf("app.mount('#app')")
    assert.ok(bootstrapPos > 0)
    assert.ok(routerPos > bootstrapPos, 'hash 引导必须发生在 app.use(router) 之前')
    assert.ok(mountPos > bootstrapPos, 'hash 引导必须发生在 app.mount 之前')
    // 先抹 hash 再写 settings：抹除是安全动作（令牌不留在地址栏/历史），不依赖业务写入成功
    const stripPos = source.indexOf("history.replaceState(null, '', stripHashFromUrl(window.location.href))")
    assert.ok(stripPos > 0 && stripPos < bootstrapPos, 'replaceState 必须先于 applyTunnelBootstrap 执行')
})

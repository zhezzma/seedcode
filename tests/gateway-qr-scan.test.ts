import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import zhMessages from '../src/i18n/zh.ts'
import enMessages from '../src/i18n/en.ts'
import { parseGatewayShareQr, isValidShareToken } from '../src/utils/gateway-qr.ts'

// 网关设置「扫码导入」契约：
//   - 解析器：`${apiBaseUrl}/#token=<urlencoded>` → {apiBaseUrl, token}（生成端 TunnelProviderSection.shareUrl）；
//   - 扫码语义 = 开新草稿后填表，绝不自动保存（与「添加服务器」按钮等价），且必须先开草稿再填表；
//   - 两个按钮（添加服务器 / 扫码）同一行；
//   - 扫码弹窗任意途径关闭都停相机（含退后台/await 竞态）；
//   - i18n zh/en gateway 段逐键对齐。
const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')
const read = (p: string) => readFileSync(path.join(repoRoot, p), 'utf8')

// ---------- 解析器 ----------

test('parse: 标准分享码（urlencoded token 解码 + 去尾斜杠）', () => {
    assert.deepEqual(
        parseGatewayShareQr('https://demo.example.com/#token=abc123%2Bz%2F='),
        { apiBaseUrl: 'https://demo.example.com', token: 'abc123+z/=' },
    )
})

test('parse: 带端口与路径的地址保留路径，仅去 hash', () => {
    assert.deepEqual(
        parseGatewayShareQr('http://192.168.1.5:3000/base/#token=t1'),
        { apiBaseUrl: 'http://192.168.1.5:3000/base', token: 't1' },
    )
})

test('parse: query 整体丢弃（分享协议未定义 query；保留会让 base 拼接错位）', () => {
    assert.deepEqual(
        parseGatewayShareQr('https://h.example.com/base?x=1#token=t'),
        { apiBaseUrl: 'https://h.example.com/base', token: 't' },
    )
    // query 值里的斜杠不得被尾斜杠抹平误伤
    assert.deepEqual(
        parseGatewayShareQr('https://h.example.com/?u=x/#token=t'),
        { apiBaseUrl: 'https://h.example.com', token: 't' },
    )
})

test('parse: IPv6 字面量主机', () => {
    assert.deepEqual(
        parseGatewayShareQr('http://[::1]:3000/#token=x'),
        { apiBaseUrl: 'http://[::1]:3000', token: 'x' },
    )
})

test('parse: userinfo（basic auth 凭据）绝不进入 apiBaseUrl', () => {
    assert.deepEqual(
        parseGatewayShareQr('http://user:pass@host.example.com:8080/base/#token=x'),
        { apiBaseUrl: 'http://host.example.com:8080/base', token: 'x' },
    )
})

test('parse: 无 hash 裸地址 → 只填地址不填令牌', () => {
    assert.deepEqual(
        parseGatewayShareQr('https://lan.example.com:3000'),
        { apiBaseUrl: 'https://lan.example.com:3000', token: '' },
    )
})

test('parse: 非 token hash（SPA 路由）按裸地址处理', () => {
    assert.deepEqual(
        parseGatewayShareQr('https://h.example.com/#/somewhere'),
        { apiBaseUrl: 'https://h.example.com', token: '' },
    )
})

test('parse: #token= 前缀命中却是空值 → 整单拒收（不静默降级为无令牌导入）', () => {
    // 用户明确想给令牌却拿到坏码：降级成「只填地址」会让人以为令牌已随码导入
    assert.equal(parseGatewayShareQr('https://h.example.com/#token='), null)
    assert.equal(parseGatewayShareQr('https://h.example.com/#token=%20%20'), null)
})

test('parse: #Token= 大小写变体也识别令牌（手工生成的码常见）', () => {
    assert.deepEqual(
        parseGatewayShareQr('https://h.example.com/#Token=abc'),
        { apiBaseUrl: 'https://h.example.com', token: 'abc' },
    )
})

test('parse: token 首尾空格抹平（%20 首尾）', () => {
    assert.deepEqual(
        parseGatewayShareQr('https://h.example.com/#token=%20abc%20'),
        { apiBaseUrl: 'https://h.example.com', token: 'abc' },
    )
})

test('parse: token 混入控制字符（%0A/%00/%09）直接拒收——会进 Authorization 头', () => {
    assert.equal(parseGatewayShareQr('https://h.example.com/#token=a%0Ab'), null)
    assert.equal(parseGatewayShareQr('https://h.example.com/#token=a%00b'), null)
    assert.equal(parseGatewayShareQr('https://h.example.com/#token=a%09b'), null)
})

test('parse: 非 Latin-1 token（中文 %E4%BB%A4）拒收——Headers ByteString 校验必抛 TypeError', () => {
    // 旧黑名单（仅 C0+DEL）会放行：写进网关联通后该网关全站请求报「网络错误」
    assert.equal(parseGatewayShareQr('https://h.example.com/#token=%E4%BB%A4'), null)
    assert.equal(parseGatewayShareQr('https://h.example.com/#token=abc%E4%BB%A4'), null)
})

test('parse: C1 控制区（%C2%85 NEL）拒收——虽属 Latin-1 但不可打印', () => {
    assert.equal(parseGatewayShareQr('https://h.example.com/#token=abc%C2%85'), null)
})

test('isValidShareToken：可打印 ASCII 白名单（与 tunnel-hash 共用的单一实现）', () => {
    for (const ok of ['a', 'abc123+z/=', '0123456789abcdef', '~!#$%^&*()_+-', 'A'.repeat(200)]) {
        assert.equal(isValidShareToken(ok), true, `${JSON.stringify(ok)} 应通过`)
    }
    for (const bad of ['令', 'a b', 'a\u0085b', 'a\nb', 'a\u0000b', 'a\tb', 'é', 'a\u007fb']) {
        assert.equal(isValidShareToken(bad), false, `${JSON.stringify(bad)} 应拒收`)
    }
})

test('parse: 多尾斜杠与首尾空白包裹', () => {
    assert.deepEqual(
        parseGatewayShareQr('  https://h.example.com///#token=x  '),
        { apiBaseUrl: 'https://h.example.com', token: 'x' },
    )
})

test('parse: token 解码失败回退原文，不整单拒绝', () => {
    const info = parseGatewayShareQr('https://h.example.com/#token=a%zz')
    assert.ok(info)
    assert.equal(info.token, 'a%zz')
})

test('parse: 非法输入一律 null', () => {
    assert.equal(parseGatewayShareQr(''), null)
    assert.equal(parseGatewayShareQr('   '), null)
    assert.equal(parseGatewayShareQr('not a url'), null)
    assert.equal(parseGatewayShareQr('ftp://h.example.com/#token=x'), null)
    assert.equal(parseGatewayShareQr('javascript:alert(1)'), null)
    assert.equal(parseGatewayShareQr('data:text/html,hi'), null)
    assert.equal(parseGatewayShareQr('mailto:a@b.c'), null)
    assert.equal(parseGatewayShareQr('//h.example.com/#token=x'), null)
})

// ---------- SettingsView 扫码语义 ----------

const settingsView = read('src/views/SettingsView.vue')

/** 提取顶层处理器源码段（到下一个顶层 const 声明或 </script> 为止，剥掉尾随的下一函数 JSDoc）。 */
function handlerBody(source: string, name: string): string {
    const start = source.indexOf(`const ${name} = `)
    assert.ok(start > 0, `SettingsView 缺少 ${name}`)
    const rest = source.slice(start)
    const next = rest.slice(1).search(/\nconst |\n<\/script>/)
    const body = next < 0 ? rest : rest.slice(0, next + 1)
    // 下一个声明的 JSDoc 注释块不属于本处理器断言域
    return body.split('/**')[0]
}

test('onQrDecoded：解析失败先 return（表单纹丝不动），成功先开草稿再填表，绝不保存', () => {
    const body = handlerBody(settingsView, 'onQrDecoded')
    // 顺序语义核心：startNewGatewayDraft 会清空表单，若挪到填表之后，扫码导入就变成「打开空白草稿」
    assert.ok(
        body.indexOf('if (!info)') < body.indexOf('startNewGatewayDraft()'),
        '解析失败必须先于开草稿（失败路径不得清空用户正在编辑的表单）',
    )
    assert.ok(
        body.indexOf('startNewGatewayDraft()') < body.indexOf('editForm.value.apiBaseUrl'),
        '必须先开草稿再填表（草稿初始化会清空刚填的值）',
    )
    assert.ok(body.includes('editForm.value.apiBaseUrl'), '必须填地址')
    assert.ok(body.includes('editForm.value.token'), '必须填令牌')
    assert.ok(!body.includes('saveGatewayForm'), '扫码导入绝不自动保存')
})

test('两个按钮（添加服务器 / 扫码）同一行容器（结构化锚定，不吃文件里其他 flex gap-2）', () => {
    const row = settingsView.match(
        /<div class="[^"]*\bflex gap-2\b[^"]*">[\s\S]*?gateway\.scanServer[\s\S]*?<\/div>/,
    )?.[0]
    assert.ok(row, '找不到「添加服务器/扫码」按钮行')
    assert.ok(row.includes('gateway.addServer'), '按钮行里要有添加服务器')
    assert.ok(row.includes('openQrScan'), '扫码按钮触发扫码')
    assert.ok(
        (row.match(/flex-1/g) ?? []).length >= 2,
        '两个按钮均分一行',
    )
})

test('扫码组件已挂载并接 decoded 事件（宽松断言，容忍属性换行/重排）', () => {
    assert.match(settingsView, /<QrScannerModal\b/)
    assert.match(settingsView, /ref="qrScannerRef"/)
    assert.match(settingsView, /@decoded="onQrDecoded"/)
})

// ---------- QrScannerModal 相机生命周期 ----------

const scanner = read('src/components/QrScannerModal.vue')

test('扫码弹窗：任意关闭途径都停相机（close 钩子/卸载/退后台）', () => {
    assert.ok(scanner.includes('@close="onDialogClose"'), 'dialog close 事件必须接停相机')
    assert.match(scanner, /const onDialogClose = \(\) => \{[\s\S]*?stopCamera\(\)/)
    assert.ok(scanner.includes('track.stop()'), '必须停掉媒体轨道')
    assert.match(scanner, /onBeforeUnmount\(\(\) => \{[\s\S]*?stopCamera\(\)/, '组件卸载也要停相机')
    assert.ok(scanner.includes("addEventListener('visibilitychange'"), '退后台必须停相机（track 不随 rAF 暂停）')
    assert.ok(scanner.includes("removeEventListener('visibilitychange', onVisibilityChange)"),
        '关闭/卸载必须摘除退后台监听（否则关窗后仍会重启相机）')
})

test('扫码弹窗：跨 await 竞态由会话令牌把门（关弹窗/重开后旧流落地即回收）', () => {
    assert.match(scanner, /const my = \+\+session/, 'startCamera 必须领取会话令牌')
    assert.match(scanner, /if \(my !== session\) \{[\s\S]*?track\.stop\(\)/, '令牌失配的迟到流必须立即回收')
    assert.match(scanner, /if \(dialogEl\.value\?\.open\) return/, 'open 必须有重入守卫（双击=双采集会话的根源）')
    assert.match(scanner, /if \(!video \|\| !video\.srcObject\) return/, '流已清时解码循环必须终止，不得空转续命')
})

test('扫码弹窗：catch 分支带会话令牌守卫（迟到的失败续体不得杀掉当前会话的流）', () => {
    // 旧会话的 getUserMedia 此刻才 reject：与当前会话无关，必须立即 return
    assert.match(scanner, /catch \{[\s\S]{0,120}?my !== session/, 'catch 必须先判令牌')
    const catchAt = scanner.indexOf('} catch {')
    assert.ok(catchAt > 0, 'startCamera 的 catch 分支不存在')
    const catchBlock = scanner.slice(catchAt, catchAt + 500)
    assert.ok(catchBlock.indexOf('my !== session') < catchBlock.indexOf('stopCamera()'),
        '令牌守卫必须先于任何回收动作')
    assert.ok(!catchBlock.includes('releaseStream()'),
        'catch 不得用 releaseStream（漏清 raf/令牌，旧循环续命）')
    assert.ok(catchBlock.includes('console.warn'), '失败必须留日志，不得静默吞掉')
    assert.ok(catchBlock.includes('cameraError.value'), '当前会话失败仍要给出可见提示')
})

test('扫码弹窗：拿不到 2D 上下文时报错并停相机（不留静默死亡的常亮相机）', () => {
    const ctxAt = scanner.indexOf('if (!ctx)')
    assert.ok(ctxAt > 0)
    const block = scanner.slice(ctxAt, ctxAt + 320)
    assert.ok(block.includes('cameraError.value'), '必须给出可见错误提示')
    assert.ok(block.indexOf('stopCamera()') > block.indexOf('cameraError.value'), '提示后停相机')
})

test('扫码弹窗：解码命中即收（停相机→关弹窗→上报）', () => {
    const hit = scanner.indexOf('if (code?.data)')
    assert.ok(hit > 0)
    // 相对查找定位三个动作的先后，不用固定窗口魔数
    const stopAt = scanner.indexOf('stopCamera()', hit)
    const closeAt = scanner.indexOf('.close()', hit)
    const emitAt = scanner.indexOf("emit('decoded'", hit)
    assert.ok(stopAt >= 0 && closeAt > stopAt && emitAt > closeAt, '顺序必须是 停相机 → 关弹窗 → emit')
})

test('扫码弹窗：嵌套 modal 焦点圈钳制（Tab 不得逃逸到先开的网关弹窗）', () => {
    // 焦点逃到先开的网关弹窗（top layer 里的另一个 dialog）时按键不经过本 dialog：
    // 模板级 @keydown 收不到，只有 document 捕获阶段才拦得住
    assert.ok(!scanner.includes('@keydown="trapFocus"'), 'dialog 级 @keydown 对逃逸后的按键是死代码')
    assert.match(scanner, /document\.addEventListener\('keydown', trapFocus, true\)/, '焦点圈必须挂 document 捕获阶段')
    assert.match(scanner, /document\.removeEventListener\('keydown', trapFocus, true\)/, '关闭/卸载必须摘除捕获监听')
    assert.match(scanner, /const trapFocus = \(event: KeyboardEvent\)/)
    assert.ok(scanner.includes("event.key !== 'Tab'"), '只拦 Tab 键')
    // 注册顺序：showModal 成功之后才挂监听（开窗失败不残留全局监听）
    const showModalAt = scanner.indexOf('showModal()')
    const trapAt = scanner.indexOf("document.addEventListener('keydown', trapFocus, true)")
    assert.ok(showModalAt > 0 && trapAt > showModalAt, '焦点圈注册必须在 showModal 之后')
    // backdrop 里的隐形 close 按钮不进焦点环（焦点停在不可见元素上等于圈断）
    assert.match(scanner, /\.filter\(\(el\) => !el\.closest\('\.modal-backdrop'\)\)/)
})

test('扫码弹窗：showModal 异常只告警不开采集（不残留 visibilitychange 监听）', () => {
    assert.match(scanner, /try \{[\s\S]{0,80}?dialogEl\.value\?\.showModal\(\)[\s\S]{0,160}?catch \(e\) \{/,
        'showModal 必须包在 try/catch 内')
    const warnAt = scanner.indexOf('showModal failed')
    assert.ok(warnAt > 0, '异常分支必须 console.warn')
    const visAt = scanner.indexOf("document.addEventListener('visibilitychange', onVisibilityChange)")
    assert.ok(visAt > scanner.indexOf('showModal()'), 'visibilitychange 注册必须在 showModal 成功之后')
})

test('扫码弹窗使用 jsQR 解码（全平台一致，不依赖 BarcodeDetector）', () => {
    assert.ok(scanner.includes("from 'jsqr'"))
    assert.ok(!scanner.toLowerCase().includes('barcodedetector'))
})

// ---------- i18n 对齐 ----------

const KEYS = ['scanServer', 'scanTitle', 'scanHint', 'scanInvalid', 'scanCameraError'] as const

test('i18n zh/en gateway 段新增扫码键逐键对齐且非空', () => {
    for (const key of KEYS) {
        const zh = (zhMessages.gateway as Record<string, string>)[key]
        const en = (enMessages.gateway as Record<string, string>)[key]
        assert.ok(typeof zh === 'string' && zh.length > 0, `zh.gateway.${key} 缺失`)
        assert.ok(typeof en === 'string' && en.length > 0, `en.gateway.${key} 缺失`)
    }
})

test('i18n zh/en gateway 段键集整体一致（防单侧加键漂移）', () => {
    assert.deepEqual(
        Object.keys(zhMessages.gateway).sort(),
        Object.keys(enMessages.gateway).sort(),
    )
})

// ---------- Android manifest（gen/ 生成物内的手工增量，防静默丢失） ----------

test('AndroidManifest 含 CAMERA 权限与可选 uses-feature（重新 init 后需补回的锚点）', () => {
    const manifest = read('src-tauri/gen/android/app/src/main/AndroidManifest.xml')
    assert.ok(manifest.includes('android.permission.CAMERA'), '缺 CAMERA 权限：真机扫码会永远走错误分支')
    assert.ok(
        manifest.includes('android.hardware.camera" android:required="false"'),
        '缺 uses-feature required=false：无摄像头设备（TV 盒子）会被安装器过滤',
    )
    // CAMERA 权限隐含硬件特性依赖：autofocus 不显式声明可选，固定对焦/TV 设备同样被筛掉
    assert.ok(
        manifest.includes('android.hardware.camera.autofocus" android:required="false"'),
        '缺 camera.autofocus 可选声明：安装器按隐含特性过滤 TV 盒子',
    )
})

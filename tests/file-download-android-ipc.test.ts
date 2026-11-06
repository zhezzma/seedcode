import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')

const fileDownloadSource = readFileSync(path.join(repoRoot, 'src/utils/fileDownload.ts'), 'utf8')
const fileActionsSource = readFileSync(path.join(repoRoot, 'src/composables/useFileActions.ts'), 'utf8')
const libRs = readFileSync(path.join(repoRoot, 'src-tauri/src/lib.rs'), 'utf8')
const capability = readFileSync(path.join(repoRoot, 'src-tauri/capabilities/default.json'), 'utf8')
const enSource = readFileSync(path.join(repoRoot, 'src/i18n/en.ts'), 'utf8')
const zhSource = readFileSync(path.join(repoRoot, 'src/i18n/zh.ts'), 'utf8')

// ─── 行为测试：saveBlob 的 Tauri IPC 路由 ───
// invoke（@tauri-apps/api/core）与 plugin-fs 的 writeFile 最终都汇到同一个缝：
// window.__TAURI_INTERNALS__.invoke(cmd, args, options)。在这里拦截即可断言
// 安卓 / 桌面各自发出什么命令、不发什么命令，无需 mock 任何模块。

interface InvokeCall { cmd: string; args: unknown; options: unknown }
const invokeCalls: InvokeCall[] = []

// 最小 FileReader 替身：readAsDataURL 用 blob.arrayBuffer() + btoa 产出 data URL。
// 真机上由 WebView 原生实现，转码不占 JS 主线程。
class FakeFileReader {
    onload: (() => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    result: unknown = null
    readAsDataURL(blob: Blob): void {
        blob.arrayBuffer().then((buf) => {
            let bin = ''
            for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
            this.result = `data:application/octet-stream;base64,${btoa(bin)}`
            this.onload?.()
        })
    }
}

const ANDROID_WV_UA = 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Mobile Safari/537.36'
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

function setNavigator(userAgent: string): void {
    Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent }, configurable: true, writable: true,
    })
}

// fileDownload.ts 顶层不触碰 window/navigator（都延迟到函数内读取），
// 导入一次、按用例切换 UA 即可覆盖两条分支。
;(globalThis as any).window = {
    __TAURI_INTERNALS__: {
        invoke: (cmd: string, args: unknown, options: unknown) => {
            invokeCalls.push({ cmd, args, options })
            return Promise.resolve('/storage/emulated/0/Download/mock.apk')
        },
    },
}
;(globalThis as any).FileReader = FakeFileReader
setNavigator(DESKTOP_UA)

const { saveBlob } = await import(
    pathToFileURL(path.join(repoRoot, 'src/utils/fileDownload.ts')).href
)

test('saveBlob（Android Tauri）：大文件绕开 fs 插件 writeFile，改走 write_download_file 传 base64', async () => {
    // 根因回归：Android 上 wry 读不了自定义协议请求体，fs 插件 writeFile 的
    // Uint8Array 被 IPC 序列化成 JSON 数字数组——32MB 文件膨胀成 100MB+ 字符串，
    // Array.from + JSON.stringify 全程同步冻结 WebView 主线程数十秒。
    // 修复后安卓分支必须改走自家 base64 命令，且不再发 plugin:fs|write_file。
    invokeCalls.length = 0
    setNavigator(ANDROID_WV_UA)

    const blob = new Blob([new Uint8Array([0x00, 0x01, 0x02, 0xff])])
    const savedPath = await saveBlob(blob, 'app-release-signed.apk')

    assert.equal(invokeCalls.length, 1, `expected exactly 1 invoke, got ${JSON.stringify(invokeCalls.map(c => c.cmd))}`)
    assert.equal(invokeCalls[0].cmd, 'write_download_file')
    // 载荷：文件名 + 剥掉 data URL 前缀的纯 base64（与 write_share_cache_file 同款契约）
    assert.deepEqual(invokeCalls[0].args, {
        fileName: 'app-release-signed.apk',
        base64Data: 'AAEC/w==',
    })
    // 绝不能再走 fs 插件 writeFile（JSON 数字数组 IPC 的冻结源头）
    assert.ok(!invokeCalls.some(c => c.cmd === 'plugin:fs|write_file'))
    // 返回落盘绝对路径（供 toast 展示）
    assert.equal(savedPath, '/storage/emulated/0/Download/mock.apk')
})

test('saveBlob（桌面 Tauri）：仍走 fs 插件 writeFile 原始字节通道，零回归', async () => {
    invokeCalls.length = 0
    setNavigator(DESKTOP_UA)

    const blob = new Blob([new Uint8Array([0x00, 0x01, 0x02, 0xff])])
    const savedPath = await saveBlob(blob, 'notes.txt')

    assert.equal(invokeCalls.length, 1, `expected exactly 1 invoke, got ${JSON.stringify(invokeCalls.map(c => c.cmd))}`)
    assert.equal(invokeCalls[0].cmd, 'plugin:fs|write_file')
    // 载荷仍是 Uint8Array 原始字节（桌面自定义协议支持 octet-stream，无膨胀）
    assert.ok(invokeCalls[0].args instanceof Uint8Array)
    assert.deepEqual(Array.from(invokeCalls[0].args as Uint8Array), [0, 1, 2, 255])
    // path 放在 headers（fs 插件 writeFile 的既有契约），目标为 Download 直写
    const headers = (invokeCalls[0].options as { headers?: Record<string, string> })?.headers ?? {}
    assert.equal(headers.path, 'notes.txt')
    assert.ok(!invokeCalls.some(c => c.cmd === 'write_download_file'))
    assert.equal(savedPath, 'notes.txt')
})

// ─── 结构 / 配置一致性 ───

test('lib.rs：write_download_file 命令存在、已注册、base64 解码、安卓写公共下载目录', () => {
    assert.match(libRs, /fn write_download_file/)
    assert.match(libRs, /write_download_file,/, 'must be registered in generate_handler')
    assert.match(libRs, /decode\(base64_data\)/)
    // 安卓 home_dir 在 tauri 解析为外置存储根 /storage/emulated/0，join("Download")
    // 即公共下载目录——与前端旧 getTauriDownloadTarget 的落点严格一致
    assert.match(libRs, /home_dir\(\)[\s\S]{0,120}join\("Download"\)/)
    // 桌面分支解析 download_dir（双分支都要在对应平台编译）
    assert.match(libRs, /download_dir\(\)/)
})

test('capabilities：安卓下载改道自家命令后，fs 插件不再需要 Home scope', () => {
    // fs:allow-write-file + $DOWNLOAD/* 仍保留给桌面原始字节通道；
    // $HOME/Download/* 只服务安卓 fs 写路径，安卓已改道即成死 scope——移除。
    assert.match(capability, /"fs:allow-write-file"/)
    assert.match(capability, /\$DOWNLOAD\/\*/)
    assert.doesNotMatch(capability, /\$HOME\//)
})

test('useFileActions：下载期间常驻「正在下载」toast，完成/失败时移除', () => {
    assert.match(fileActionsSource, /toast\.info\(tr\('workspace\.menu\.downloading'\), 0\)/)
    assert.match(fileActionsSource, /toast\.remove\(downloadingId\)/)
})

test('i18n：downloading 键双侧对齐', () => {
    assert.match(enSource, /downloading: 'Downloading…'/)
    assert.match(zhSource, /downloading: '正在下载…'/)
})

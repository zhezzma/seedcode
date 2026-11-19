import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')

const fileDownloadSource = readFileSync(path.join(repoRoot, 'src/utils/fileDownload.ts'), 'utf8')
const fileActionsSource = readFileSync(path.join(repoRoot, 'src/composables/useFileActions.ts'), 'utf8')
const viewerActionsSource = readFileSync(path.join(repoRoot, 'src/composables/useViewerActions.ts'), 'utf8')
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

const { saveBlob, saveUrlToSystemFile } = await import(
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

// ─── 行为测试：saveUrlToSystemFile 的流式分块中转（大文件 OOM 修复） ───

/** 构造按给定分片顺序吐字节的 Response（Node 18+ 原生 ReadableStream）。 */
function streamingResponse(slices: Uint8Array[], status = 200): Response {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const slice of slices) controller.enqueue(slice)
            controller.close()
        },
    })
    return new Response(stream, { status })
}

test('saveUrlToSystemFile（Android Tauri）：按 4MB 分块中转，首块 append=false 后续 true', async () => {
    // 根因回归：237MB debug APK 走「整块 blob → base64 → 一次 invoke」时 WebView
    // 渲染进程堆峰值 ~3.7×文件大小，Android 直接 OOM 崩溃。修复后必须分块流式中转，
    // 单块 IPC 载荷有上界（4MB 原始 → ~5.3MB base64），与文件总大小无关。
    invokeCalls.length = 0
    setNavigator(ANDROID_WV_UA)
    const originalFetch = (globalThis as any).fetch
    const fetchCalls: { url: string; headers: unknown }[] = []
    ;(globalThis as any).fetch = async (url: string, init: any) => {
        fetchCalls.push({ url, headers: init?.headers })
        return streamingResponse([
            new Uint8Array(4 * 1024 * 1024),
            new Uint8Array(64 * 1024 + 1),
        ])
    }
    try {
        const savedPath = await saveUrlToSystemFile(
            'http://gw:8080/api/agents/coder/download?path=dist-android%2Fapp-debug.apk',
            { Authorization: 'Bearer t' },
            'app-debug.apk',
        )
        // URL 与鉴权头原样透传给 fetch
        assert.equal(fetchCalls[0].url, 'http://gw:8080/api/agents/coder/download?path=dist-android%2Fapp-debug.apk')
        assert.deepEqual(fetchCalls[0].headers, { Authorization: 'Bearer t' })
        // 两块：4MB 整块 + 64KB+1 尾块；append 语义首块 false、后续 true
        assert.equal(invokeCalls.length, 2, `expected 2 chunk invokes, got ${invokeCalls.length}`)
        assert.ok(invokeCalls.every(c => c.cmd === 'write_download_chunk'))
        assert.equal(invokeCalls[0].args.append, false)
        assert.equal(invokeCalls[0].args.fileName, 'app-debug.apk')
        // 首块 base64 长度 = ceil(4MiB/3)*4（载荷有上界的直接证据）
        assert.equal(invokeCalls[0].args.base64Data.length, Math.ceil((4 * 1024 * 1024) / 3) * 4)
        assert.equal(invokeCalls[1].args.append, true)
        assert.equal(invokeCalls[1].args.base64Data.length, Math.ceil((64 * 1024 + 1) / 3) * 4)
        assert.equal(savedPath, '/storage/emulated/0/Download/mock.apk')
    } finally {
        ;(globalThis as any).fetch = originalFetch
    }
})

test('saveUrlToSystemFile（Android Tauri）：空文件也建出空文件（单次 append=false 空块）', async () => {
    invokeCalls.length = 0
    setNavigator(ANDROID_WV_UA)
    const originalFetch = (globalThis as any).fetch
    ;(globalThis as any).fetch = async () => streamingResponse([])
    try {
        const savedPath = await saveUrlToSystemFile('http://gw/x', undefined, 'empty.bin')
        assert.equal(invokeCalls.length, 1)
        assert.equal(invokeCalls[0].cmd, 'write_download_chunk')
        assert.equal(invokeCalls[0].args.append, false)
        assert.equal(invokeCalls[0].args.base64Data, '')
        assert.equal(savedPath, '/storage/emulated/0/Download/mock.apk')
    } finally {
        ;(globalThis as any).fetch = originalFetch
    }
})

test('saveUrlToSystemFile（Android Tauri）：非 2xx 解析服务端 {error} 并抛出，不落盘', async () => {
    invokeCalls.length = 0
    setNavigator(ANDROID_WV_UA)
    const originalFetch = (globalThis as any).fetch
    ;(globalThis as any).fetch = async () =>
        new Response(JSON.stringify({ error: 'file too large' }), { status: 413 })
    try {
        await assert.rejects(
            saveUrlToSystemFile('http://gw/x', undefined, 'a.bin'),
            /file too large/,
        )
        assert.equal(invokeCalls.length, 0)
    } finally {
        ;(globalThis as any).fetch = originalFetch
    }
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

test('lib.rs：write_download_chunk 命令存在、已注册、append/truncate 二选一、与整块共用目标路径', () => {
    assert.match(libRs, /fn write_download_chunk/)
    assert.match(libRs, /write_download_chunk,/, 'must be registered in generate_handler')
    // append 与 truncate 互斥，不能同时置位（std 在部分平台报错）
    assert.match(libRs, /if append \{\s*options\.append\(true\);\s*\} else \{\s*options\.truncate\(true\);/)
    // 分块与整块共用目录/消毒逻辑，落点一致
    assert.match(libRs, /fn download_target_path/)
    assert.match(libRs, /download_target_path\(&app, &file_name\)/)
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

test('useFileActions / useViewerActions：大文件下载改走流式 downloadToFile，不再整块 fetchDownload+saveBlob', () => {
    // 崩溃根因：两处 UI 下载入口原先 fetchDownload（整块 blob）+ saveBlob（整块 base64
    // 过 IPC），237MB debug APK 在 Android 渲染进程堆峰值 ~3.7× 直接 OOM。必须改走
    // downloadToFile（流式分块），且源码里不再残留整块链路。
    assert.match(fileActionsSource, /downloadToFile\(agentId, entry\.path, entry\.name, scope\)/)
    assert.doesNotMatch(fileActionsSource, /fetchDownload/)
    assert.doesNotMatch(fileActionsSource, /saveBlob/)
    assert.match(viewerActionsSource, /downloadToFile\(agentId, path, name, scope\)/)
    assert.doesNotMatch(viewerActionsSource, /fetchDownload/)
})

test('i18n：downloading 键双侧对齐', () => {
    assert.match(enSource, /downloading: 'Downloading…'/)
    assert.match(zhSource, /downloading: '正在下载…'/)
})

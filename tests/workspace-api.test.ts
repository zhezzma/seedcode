import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useUiSettingsStore } from '../src/stores/setting.ts'
import * as api from '../src/composables/workspace-api.ts'

const originalFetch = globalThis.fetch
const originalLocalStorage = globalThis.localStorage

test.beforeEach(() => {
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => storage.get(k) ?? null,
            setItem: (k: string, v: string) => { storage.set(k, v) },
            removeItem: (k: string) => { storage.delete(k) },
            clear: () => storage.clear(),
            key: () => null,
            length: 0,
        },
    })
    setActivePinia(createPinia())
    const settings = useUiSettingsStore()
    settings.apiBaseUrl = 'http://localhost:8088'
    settings.token = 'tk'
})

test.afterEach(() => {
    globalThis.fetch = originalFetch
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage })
})

test('fetchTree 拼对路径与查询参数', async () => {
    let captured: { url: string, init?: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(JSON.stringify({ ok: true, payload: { root: '/ws', path: 'src', entries: [] } }), {
            status: 200, headers: { 'content-type': 'application/json' },
        })
    }) as any

    const r = await api.fetchTree('coder', 'src')
    assert.equal(r.path, 'src')
    assert.match(captured!.url, /\/api\/agents\/coder\/workspace\/tree\?path=src$/)
})

test('fetchTree 空 path 不带参数', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(JSON.stringify({ ok: true, payload: { root: '/ws', path: '', entries: [] } }), { status: 200 })
    }) as any
    await api.fetchTree('coder', '')
    assert.match(captured, /\/workspace\/tree$/)
})

test('fetchDiff: untracked 模式仅传 file', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(JSON.stringify({ ok: true, payload: { mode: 'untracked', file: 'a', binary: false, truncated: false, diff: '' } }), { status: 200 })
    }) as any
    await api.fetchDiff('coder', { repo: 'r', mode: 'untracked', file: 'a' })
    assert.match(captured, /mode=untracked/)
    assert.match(captured, /file=a/)
})

test('fetchDiff: commit 模式带 ref', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(JSON.stringify({ ok: true, payload: { mode: 'commit', file: 'a', binary: false, truncated: false, diff: '' } }), { status: 200 })
    }) as any
    await api.fetchDiff('coder', { repo: 'r', mode: 'commit', ref: 'abc123', file: 'a' })
    assert.match(captured, /ref=abc123/)
})

test('fetchCommitFiles 拼对路径', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(JSON.stringify({ ok: true, payload: { ref: 'sha', files: [] } }), { status: 200 })
    }) as any
    await api.fetchCommitFiles('coder', 'r', 'sha')
    assert.match(captured, /\/repo\/commit\/files\?repo=r&ref=sha/)
})

test('fetchFile 拼 agent-scoped path', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(JSON.stringify({
            ok: true,
            payload: { path: 'src/a.ts', binary: false, truncated: false, content: 'hello' },
        }), { status: 200 })
    }) as any
    const r = await api.fetchFile('coder', 'src/a.ts')
    assert.equal(r.content, 'hello')
    assert.match(captured, /\/api\/agents\/coder\/workspace\/file\?path=src%2Fa\.ts$/)
})

test('saveFile 发 PUT 带 JSON body', async () => {
    let captured: { url: string, init?: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(JSON.stringify({ ok: true, payload: { path: 'src/a.ts', bytes: 5 } }), { status: 200 })
    }) as any
    const r = await api.saveFile('coder', 'src/a.ts', 'hello')
    assert.equal(r.bytes, 5)
    assert.equal(captured!.init!.method, 'PUT')
    assert.match(String((captured!.init!.headers as any)['content-type']), /application\/json/)
    assert.equal(captured!.init!.body, JSON.stringify({ content: 'hello' }))
    assert.match(captured!.url, /\/api\/agents\/coder\/workspace\/file\?path=src%2Fa\.ts$/)
})

test('saveFile HTTP 错误抛出 WorkspaceApiError', async () => {
    globalThis.fetch = (async () => {
        return new Response(JSON.stringify({ ok: false, error: 'File not found' }), { status: 404 })
    }) as any
    await assert.rejects(
        () => api.saveFile('coder', 'nope', 'x'),
        (err: any) => /File not found/.test(err.message),
    )
})

test('fetchAgentTree 拼 agent-tree 路径', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(JSON.stringify({ ok: true, payload: { root: '/agent', path: '', entries: [] } }), { status: 200 })
    }) as any
    await api.fetchAgentTree('coder', '')
    assert.match(captured, /\/api\/agents\/coder\/workspace\/agent-tree$/)
})

test('fetchAgentFile 拼 agent-file 路径', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(JSON.stringify({
            ok: true,
            payload: { path: 'AGENTS.md', binary: false, truncated: false, content: '# x' },
        }), { status: 200 })
    }) as any
    const r = await api.fetchAgentFile('coder', 'AGENTS.md')
    assert.equal(r.content, '# x')
    assert.match(captured, /\/agent-file\?path=AGENTS\.md$/)
})

test('saveAgentFile 发 PUT 到 agent-file', async () => {
    let captured: { url: string, init?: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(JSON.stringify({ ok: true, payload: { path: 'AGENTS.md', bytes: 3 } }), { status: 200 })
    }) as any
    const r = await api.saveAgentFile('coder', 'AGENTS.md', '# x')
    assert.equal(r.bytes, 3)
    assert.equal(captured!.init!.method, 'PUT')
    assert.match(captured!.url, /\/agent-file\?path=AGENTS\.md$/)
})

test('fetchFileVersions: untracked 仅传 file', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(JSON.stringify({
            ok: true,
            payload: { mode: 'untracked', file: 'a', binary: false, truncated: false, before: null, after: 'x' },
        }), { status: 200 })
    }) as any
    const r = await api.fetchFileVersions('coder', { repo: 'r', mode: 'untracked', file: 'a' })
    assert.equal(r.before, null)
    assert.equal(r.after, 'x')
    assert.match(captured, /\/repo\/file-versions\?/)
    assert.match(captured, /mode=untracked/)
    assert.match(captured, /file=a/)
})

test('fetchFileVersions: commit 模式带 ref', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(JSON.stringify({
            ok: true,
            payload: { mode: 'commit', file: 'a', binary: false, truncated: false, before: '1', after: '2' },
        }), { status: 200 })
    }) as any
    await api.fetchFileVersions('coder', { repo: 'r', mode: 'commit', ref: 'abc123', file: 'a' })
    assert.match(captured, /ref=abc123/)
})

test('stageFiles: 不传 files 时不带 body', async () => {
    let captured: { url: string, init?: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(JSON.stringify({ ok: true, payload: { ok: true } }), { status: 200 })
    }) as any
    await api.stageFiles('coder', 'r')
    assert.match(captured!.url, /\/repo\/stage\?repo=r/)
    assert.equal(captured!.init!.method, 'POST')
    assert.equal(captured!.init!.body, undefined)
})

test('stageFiles: 传 files 时 POST {files}', async () => {
    let captured: { url: string, init?: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(JSON.stringify({ ok: true, payload: { ok: true } }), { status: 200 })
    }) as any
    await api.stageFiles('coder', 'r', ['a.ts', 'b.ts'])
    assert.equal(captured!.init!.body, JSON.stringify({ files: ['a.ts', 'b.ts'] }))
})

test('unstageFiles / discardFiles: 同 stageFiles 形态', async () => {
    let urls: string[] = []
    globalThis.fetch = (async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify({ ok: true, payload: { ok: true } }), { status: 200 })
    }) as any
    await api.unstageFiles('coder', 'r')
    await api.discardFiles('coder', 'r', ['x'])
    assert.match(urls[0], /\/repo\/unstage\?repo=r/)
    assert.match(urls[1], /\/repo\/discard\?repo=r/)
})

test('commitChanges: POST 带 message body, 返回 head', async () => {
    let captured: { url: string, init?: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(JSON.stringify({ ok: true, payload: { ok: true, head: 'abc1234', output: '[main abc1234] msg' } }), { status: 200 })
    }) as any
    const r = await api.commitChanges('coder', 'r', 'fix: x')
    assert.equal(r.head, 'abc1234')
    assert.equal(captured!.init!.method, 'POST')
    assert.equal(captured!.init!.body, JSON.stringify({ message: 'fix: x' }))
    assert.match(captured!.url, /\/repo\/commit\?repo=r/)
})

test('fetchRawFile: 默认 / workspace scope 走 /raw', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 })
    }) as any
    const blob = await api.fetchRawFile('coder', 'a.png')
    assert.ok(blob instanceof Blob)
    assert.match(captured, /\/api\/agents\/coder\/workspace\/raw\?path=a\.png$/)
})

test('fetchRawFile: agent scope 走 /agent-raw', async () => {
    let captured = ''
    globalThis.fetch = (async (url: string) => {
        captured = url
        return new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 })
    }) as any
    await api.fetchRawFile('coder', 'a.png', 'agent')
    assert.match(captured, /\/api\/agents\/coder\/workspace\/agent-raw\?path=a\.png$/)
})

test('fetchRawFile: absolute scope 走 /api/files/raw 且带 auth', async () => {
    let captured: { url: string, init?: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 })
    }) as any
    await api.fetchRawFile('coder', '/tmp/pics/a.png', 'absolute')
    assert.match(captured!.url, /\/api\/files\/raw\?path=%2Ftmp%2Fpics%2Fa\.png$/)
    assert.equal((captured!.init!.headers as Record<string, string>)['Authorization'], 'Bearer tk')
})

test('fetchRawFile: absolute + /assets/ 前缀走公开静态端点，不带 auth', async () => {
    // image-gen 等工具结果里返回的是 /assets URL（服务端公开静态端点）而非文件系统路径，
    // /api/files/raw 只认真实绝对路径（existsSync 查盘），直接拼公开端点访问。
    let captured: { url: string, init?: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 })
    }) as any
    await api.fetchRawFile(
        'coder',
        '/assets/images/session/01a04b48-13ca-79bd-9be7-1375e7b2d4bd/image-x.png',
        'absolute',
    )
    assert.match(
        captured!.url,
        /^http:\/\/localhost:8088\/assets\/images\/session\/01a04b48-13ca-79bd-9be7-1375e7b2d4bd\/image-x\.png$/,
    )
    const headers = captured!.init?.headers as Record<string, string> | undefined
    // headers 严格 undefined：/assets 分支不发任何自定义头（auth 哈希为 {} 也不算过）。
    assert.equal(headers, undefined)
    assert.ok(!headers?.['Authorization'])
})

test('fetchRawFile: maxBytes 预检——content-length 超限抛 413 不拉 body，未超/缺头放行', async () => {
    // 服务端流式响应都带 content-length；预检避免大文件整段 blob() 进 WebView 内存
    globalThis.fetch = (async () =>
        new Response(new Blob(['x'], { type: 'video/mp4' }), {
            status: 200,
            headers: { 'content-length': String(65 * 1024 * 1024) },
        })) as any
    await assert.rejects(
        () => api.fetchRawFile('coder', 'big.mp4', 'workspace', undefined, { maxBytes: 64 * 1024 * 1024 }),
        /文件过大/,
    )

    // 未超限正常返回 blob
    globalThis.fetch = (async () =>
        new Response(new Blob(['x'], { type: 'video/mp4' }), {
            status: 200,
            headers: { 'content-length': '1' },
        })) as any
    const ok = await api.fetchRawFile('coder', 's.mp4', 'workspace', undefined, { maxBytes: 64 * 1024 * 1024 })
    assert.ok(ok instanceof Blob)

    // content-length 缺失（代理剥离/合成响应）：放行，blob() 兑底
    globalThis.fetch = (async () =>
        new Response(new Blob(['x'], { type: 'video/mp4' }), { status: 200 })) as any
    const fallback = await api.fetchRawFile('coder', 's.mp4', 'workspace', undefined, { maxBytes: 64 * 1024 * 1024 })
    assert.ok(fallback instanceof Blob)
})

test('uploadFile: POST multipart 到 /upload，parentPath 进 query，含 file 字段', async () => {
    let captured: { url: string, init?: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        captured = { url, init }
        return new Response(JSON.stringify({ ok: true, payload: { path: 'a.png', bytes: 3 } }), { status: 200 })
    }) as any
    const file = new File(['png'], 'a.png', { type: 'image/png' })
    const r = await api.uploadFile('coder', 'sub', file)
    assert.equal(r.bytes, 3)
    assert.equal(captured!.init!.method, 'POST')
    assert.match(captured!.url, /\/api\/agents\/coder\/workspace\/upload\?path=sub$/)
    const form = captured!.init!.body as FormData
    assert.ok(form instanceof FormData, 'body must be FormData')
    assert.ok(form.has('file'), 'FormData must contain file field')
})

test('fetchStatus 拼 repo 参数，refresh 可选透传', async () => {
    let captured: { url: string } | null = null
    globalThis.fetch = (async (url: string) => {
        captured = { url: String(url) }
        return new Response(JSON.stringify({
            ok: true,
            payload: { branch: null, upstream: null, head: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] },
        }), { status: 200 })
    }) as any

    await api.fetchStatus('coder', 'r1')
    assert.match(captured!.url, /\/workspace\/repo\/status\?repo=r1$/)

    await api.fetchStatus('coder', 'r1', { refresh: true })
    assert.match(captured!.url, /\/workspace\/repo\/status\?repo=r1&refresh=1$/, 'refresh=1 才能让服务端 fetch upstream 刷 behind')
})

test('mediaKindFromPath: 图片扩展名 → image', () => {
    for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.ico']) {
        assert.equal(api.mediaKindFromPath(p), 'image', p)
    }
    // 大小写不敏感
    assert.equal(api.mediaKindFromPath('A.PNG'), 'image')
    assert.equal(api.mediaKindFromPath('A.MOV'), 'video')
})

test('mediaKindFromPath: 音频扩展名 → audio', () => {
    for (const p of ['a.mp3', 'a.wav', 'a.ogg', 'a.oga', 'a.opus', 'a.m4a', 'a.aac', 'a.flac', 'a.weba']) {
        assert.equal(api.mediaKindFromPath(p), 'audio', p)
    }
})

test('mediaKindFromPath: 视频扩展名 → video', () => {
    for (const p of ['a.mp4', 'a.m4v', 'a.webm', 'a.ogv', 'a.mov', 'a.mkv', 'a.3gp', 'a.3g2']) {
        assert.equal(api.mediaKindFromPath(p), 'video', p)
    }
})

test('mediaKindFromPath: 非媒体 / 伪装扩展名 → null', () => {
    // SVG 仍在名单外（防同源脚本）；avi 等容器不在白名单
    for (const p of ['a.txt', 'a.md', 'a.html', 'a.svg', 'a.avi', 'a.png.txt', 'noext', 'a.']) {
        assert.equal(api.mediaKindFromPath(p), null, p)
    }
})

test('isBinaryExt: 媒体三类 + 常见二进制格式全命中（openDiff 分流的判定源）', () => {
    // 媒体三类（mediaKindFromPath 同步清单，大小写不敏感）
    for (const p of ['a.png', 'b.JPG', 'c.mp3', 'd.webm', 'e.ico', 'f.flac']) {
        assert.equal(api.isBinaryExt(p), true, p)
    }
    // 压缩包/安装包、文档、字体、可执行、数据库、keystore、3D 资源、ML 权重
    for (const p of [
        'x.zip', 'dist.tar.gz', 'app.apk', 'spec.pdf', 'report.docx', 'font.woff2',
        'bin.exe', 'lib.so', 'cache.sqlite', 'data.parquet', 'release.keystore',
        'cert.p12', 'model.glb', 'icon.tiff', 'weights.safetensors', 'train.ckpt',
    ]) {
        assert.equal(api.isBinaryExt(p), true, p)
    }
})

test('isBinaryExt: 文本格式（刻意排除项）与无扩展名不误判', () => {
    // svg/gltf 是文本格式；pem/crt 常为文本；无扩展名（Makefile）与 dotfile 按文本对待；
    // obj（Wavefront）/out（作业日志）有常见文本语义，刻意不在清单（误伤文本会丢 diff）
    for (const p of ['a.ts', 'v.vue', 'icon.svg', 'scene.gltf', 'cert.pem', 'server.crt',
        'data.json', 'README.md', 'Makefile', '.gitignore', 'plain.txt', 'mesh.obj', 'slurm-123.out']) {
        assert.equal(api.isBinaryExt(p), false, p)
    }
})

test('isBinaryExt: 先剥 query/hash 再取扩展名（同 mediaKindFromPath 策略）', () => {
    assert.equal(api.isBinaryExt('shot.png?v=2&t=3'), true)
    assert.equal(api.isBinaryExt('evil.html?.png'), false)
})

test('fetchRawFile: 透传 AbortSignal 给 fetch（切文件/卸载时中止下载防泄露）', async () => {
    // 调用方（WorkspaceFileView）在切文件/卸载时 abort，阻止媒体下载完成后
    // 创建无人 revoke 的 objectURL。三个 scope 分支都要把 signal 交给 fetch。
    const signals: (AbortSignal | undefined)[] = []
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        signals.push(init?.signal)
        return new Response(new Blob(['x'], { type: 'image/png' }), { status: 200 })
    }) as any
    const ctrl = new AbortController()
    await api.fetchRawFile('coder', 'a.png', 'workspace', ctrl.signal)
    await api.fetchRawFile('coder', 'a.png', 'agent', ctrl.signal)
    await api.fetchRawFile('coder', '/tmp/a.png', 'absolute', ctrl.signal)
    await api.fetchRawFile('coder', '/assets/x.png', 'absolute', ctrl.signal)
    assert.equal(signals.length, 4)
    for (const s of signals) assert.equal(s, ctrl.signal, '每个分支都必须透传同一个 signal')
})

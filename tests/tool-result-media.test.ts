import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractToolResultImages, extractAbsoluteToolResultImagePaths, toolResultText } from '../src/utils/tool-result-media.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ─── extractToolResultImages：image 块 → 可渲染 src ────────────────────────

test('url 形式 image 块 → resolveMediaUrl 拼 apiBaseUrl（/assets 是服务端相对路径）', () => {
    const result = [
        { type: 'image', data: '', url: '/assets/images/session/sid/x.png', mimeType: 'image/png' },
        { type: 'text', text: '<harness>\n[info] Viewed image [image/png] at /assets/images/session/sid/x.png.\n</harness>' },
    ]
    assert.deepEqual(extractToolResultImages(result, 'https://api.example.com'), [
        'https://api.example.com/assets/images/session/sid/x.png',
    ])
})

test('inline base64 形式（read）→ data URI，mimeType 缺省 image/png', () => {
    const result = [
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'image', data: 'QUJD' },
    ]
    assert.deepEqual(extractToolResultImages(result, 'https://api.example.com'), [
        'data:image/png;base64,iVBORw0KGgo=',
        'data:image/png;base64,QUJD',
    ])
})

test('url 优先于 data；无 url 无 data 的坏块跳过；非数组返回空', () => {
    const result = [
        { type: 'image', data: 'AAAA', url: '/assets/a.png', mimeType: 'image/png' },
        { type: 'image' },
        { type: 'text', text: 'hi' },
    ]
    assert.deepEqual(extractToolResultImages(result, 'https://api.example.com'), [
        'https://api.example.com/assets/a.png',
    ])
    assert.deepEqual(extractToolResultImages(null, 'https://api.example.com'), [])
    assert.deepEqual(extractToolResultImages({ type: 'image', url: '/assets/a.png' }, 'https://api.example.com'), [])
})

test('绝对路径 url 块不进直渲染列表（webview 解析不了，交由 raw 端点异步拉取）', () => {
    const result = [
        // Windows 盘符（反斜杠与正斜杠两形态）：media-url 的 scheme 正则会把 D: 误判成协议
        { type: 'image', data: '', url: 'D:\\pics\\img.png', mimeType: 'image/png' },
        { type: 'image', data: '', url: 'D:/pics/img.png', mimeType: 'image/png' },
        // Unix 根路径：直渲染会被当服务端相对路径拼 apiBaseUrl → 404 裂图
        { type: 'image', data: '', url: '/home/user/img.png', mimeType: 'image/png' },
        // file:// 前缀（防御形态，服务端通常不产）：剥前缀归入绝对路径分支
        { type: 'image', data: '', url: 'file:///D:/pics/img.png', mimeType: 'image/png' },
        { type: 'image', data: '', url: 'file:///home/user/img.png', mimeType: 'image/png' },
        // UNC：
        { type: 'image', data: '', url: '\\\\server\\\\share\\\\img.png', mimeType: 'image/png' },
        // /assets 与远程 URL 不受影响（仍可直渲染）；协议相对 URL 同样直渲染
        // （isServerSideAbsolutePath 的 // 排除回归锁：按 Unix 根前缀会误命中）
        { type: 'image', data: '', url: '/assets/a.png', mimeType: 'image/png' },
        { type: 'image', data: '', url: 'https://cdn.example.com/b.png', mimeType: 'image/png' },
        { type: 'image', data: '', url: '//cdn.example.com/c.png', mimeType: 'image/png' },
        // data 目录相对路径（非 / 开头）仍走拼接直渲染
        { type: 'image', data: '', url: 'sessions/sid/x.png', mimeType: 'image/png' },
        // inline base64 不受影响
        { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]
    assert.deepEqual(extractToolResultImages(result, 'https://api.example.com'), [
        'https://api.example.com/assets/a.png',
        'https://cdn.example.com/b.png',
        '//cdn.example.com/c.png',
        'https://api.example.com/sessions/sid/x.png',
        'data:image/png;base64,QUJD',
    ])
})

test('extractAbsoluteToolResultImagePaths：提取 image 块的绝对路径 url（按序去重）', () => {
    const result = [
        { type: 'image', data: '', url: 'D:\\pics\\img.png', mimeType: 'image/png' },
        { type: 'image', data: '', url: '/home/user/img.png' },
        { type: 'image', data: '', url: 'D:\\pics\\img.png' },
        // file:// 剥前缀后归一为磁盘路径（raw 端点直接可查）
        { type: 'image', data: '', url: 'file:///D:/pics/img.png' },
        { type: 'image', data: '', url: 'file:///home/user/img2.png' },
        // UNC 原样
        { type: 'image', data: '', url: '\\\\server\\\\share\\\\img.png' },
        { type: 'image', data: '', url: '/assets/a.png' },
        { type: 'image', data: '', url: 'https://x/y.png' },
        { type: 'image', data: '', url: '//cdn.example.com/c.png' },
        { type: 'image', data: 'QUJD' },
        { type: 'text', text: 'hi' },
    ]
    assert.deepEqual(extractAbsoluteToolResultImagePaths(result), [
        'D:\\pics\\img.png',
        '/home/user/img.png',
        'D:/pics/img.png',
        '/home/user/img2.png',
        '\\\\server\\\\share\\\\img.png',
    ])
    assert.deepEqual(extractAbsoluteToolResultImagePaths(null), [])
    assert.deepEqual(extractAbsoluteToolResultImagePaths([{ type: 'image', url: '/assets/a.png' }]), [])
})

// ─── toolResultText：文本部分提取 ──────────────────────────────────────────

test('全文本数组 → 拼接直出', () => {
    assert.equal(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
})

test('含 image 块：取文本部分（图片另走缩略图渲染）', () => {
    const result = [
        { type: 'image', data: '', url: '/assets/a.png', mimeType: 'image/png' },
        { type: 'text', text: '<harness>\n[info] Viewed image [image/png] at /assets/a.png.\n</harness>' },
    ]
    assert.equal(toolResultText(result), '<harness>\n[info] Viewed image [image/png] at /assets/a.png.\n</harness>')
})

test('仅 image 块 → null（模板不显示文本、也不回退 JSON）', () => {
    assert.equal(toolResultText([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]), null)
})

test('单个 text 对象 → 其文本', () => {
    assert.equal(toolResultText({ type: 'text', text: 'ok' }), 'ok')
})

test('空数组 / 非文本形状 → null（回退 JSON 显示）', () => {
    assert.equal(toolResultText([]), null)
    assert.equal(toolResultText([{ type: 'json', data: { a: 1 } }]), null)
    assert.equal(toolResultText('plain string'), null)
    assert.equal(toolResultText(null), null)
})

// ─── ToolInvocation.vue 接线（忘接线 = 纯函数白测） ────────────────────────

const toolInvocationSource = readFileSync(
    path.join(repoRoot, 'src/components/chat/ToolInvocation.vue'), 'utf8')

test('ToolInvocation: 消费 tool-result-media 两个纯函数', () => {
    assert.match(toolInvocationSource,
        /import \{[^}]*extractToolResultImages[^}]*toolResultText[^}]*\} from '[^']*utils\/tool-result-media(?:\.ts)?'/,
        '应导入 extractToolResultImages + toolResultText')
    assert.match(toolInvocationSource, /toolResultText\(\s*props\.result\s*\)/,
        'textResultContent 应走 toolResultText(props.result)')
    assert.match(toolInvocationSource, /extractToolResultImages\(\s*props\.result\s*,\s*settings\.apiBaseUrl\s*\)/,
        'resultImages 应走 extractToolResultImages(props.result, settings.apiBaseUrl)')
})

test('ToolInvocation: 绝对路径图片走 fetchRawFile absolute scope 拉取后并入 resultImages', () => {
    assert.match(toolInvocationSource, /extractAbsoluteToolResultImagePaths\(\s*props\.result\s*\)/,
        '应提取 props.result 的绝对路径 image url')
    assert.match(toolInvocationSource, /fetchRawFile\(\s*''[^)]*'absolute'/,
        '绝对路径应走 fetchRawFile(\'\', path, \'absolute\')（/api/files/raw，无需 agentId）')
    assert.match(toolInvocationSource, /URL\.createObjectURL/,
        '应把 blob 转 objectURL 渲染')
    assert.match(toolInvocationSource, /revokeObjectURL/,
        '应释放 objectURL（防泄漏）')
})

test('ToolInvocation: 模板渲染 resultImages 缩略图 + JSON 回退有图片守卫', () => {
    assert.match(toolInvocationSource, /v-for="\(src, i\) in resultImages"/,
        '模板应 v-for 渲染 resultImages')
    assert.match(toolInvocationSource, /v-else-if="resultImages\.length === 0"/,
        'JSON 回退应仅在无图片时启用（仅 image 块的结果不能回退成 base64 JSON 巨块）')
})

test('ToolInvocation: view_image 专属分支已移除（[N 张图片] 前缀与缩略图重复）', () => {
    assert.ok(!toolInvocationSource.includes("props.toolName === 'view_image'"),
        '不应再有 view_image 工具名特判')
    assert.ok(!toolInvocationSource.includes('张图片'),
        '不应再有 [N 张图片] 前缀拼接')
})

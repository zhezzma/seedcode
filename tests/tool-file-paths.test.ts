// node:test 风格（纯函数，无 mock/无 vue 响应性），纳入 `node --test` 回归基线。
// 覆盖 ToolInvocation args 路径按钮的两条链路：args 键名提取 + diff 打开前的路径/仓库/模式判定。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
    extractArgsPaths,
    findRepoFor,
    isAbsolutePath,
    isAssetUrl,
    isServerSideAbsolutePath,
    isWebUrl,
    joinPath,
    pickDiffMode,
    toDiskPathForm,
    toRepoRelative,
    toSlash,
    toWorkspaceRelative,
} from '../src/utils/tool-file-paths.ts'

// ─── toDiskPathForm / isServerSideAbsolutePath：服务端磁盘绝对路径判定 ─────

test('toDiskPathForm: file:// 剥前缀归一为磁盘路径，其余原样', () => {
    assert.equal(toDiskPathForm('file:///home/u/x.png'), '/home/u/x.png', '第 3 个斜杠是路径根，保留')
    assert.equal(toDiskPathForm('file:///D:/x.png'), 'D:/x.png', '盘符前的 URL 根斜杠去掉')
    assert.equal(toDiskPathForm('D:\\x\\y.png'), 'D:\\x\\y.png')
    assert.equal(toDiskPathForm('/home/x.png'), '/home/x.png')
})

test('isServerSideAbsolutePath: 盘符/UNC/Unix 根为真；/assets、远程 URL、相对路径为假', () => {
    assert.equal(isServerSideAbsolutePath('D:\\pics\\img.png'), true)
    assert.equal(isServerSideAbsolutePath('D:/pics/img.png'), true)
    assert.equal(isServerSideAbsolutePath('/home/user/img.png'), true)
    assert.equal(isServerSideAbsolutePath('\\\\server\\share\\img.png'), true)
    assert.equal(isServerSideAbsolutePath('file:///home/u/x.png'), true, 'file:// 剥前缀后判定')
    assert.equal(isServerSideAbsolutePath('/assets/a.png'), false, '/assets 是公开静态端点，直渲染')
    assert.equal(isServerSideAbsolutePath('https://cdn.example.com/b.png'), false)
    assert.equal(isServerSideAbsolutePath('sessions/sid/x.png'), false, 'data 目录相对路径，拼 apiBaseUrl 直渲染')
})

// ─── extractArgsPaths：按参数键名提取 ─────────────────────────

test('extractArgsPaths: path/url/images 基本提取', () => {
    assert.deepEqual(
        extractArgsPaths({ path: 'src/a.ts', url: '/assets/s1/img.png', images: ['/assets/s1/a.png'] }),
        ['src/a.ts', '/assets/s1/img.png', '/assets/s1/a.png'],
    )
})

test('extractArgsPaths: http(s) 远程链接排除，磁盘路径与 /assets 保留', () => {
    assert.deepEqual(
        extractArgsPaths({ url: 'https://example.com/a.png' }),
        [],
        '远程 URL 不是本地文件',
    )
    assert.deepEqual(
        extractArgsPaths({
            url: 'D:\\pics\\img.png',
            images: ['/assets/s/a.png', 'https://x.com/b.png', 'http://y.com/c.png'],
        }),
        ['D:\\pics\\img.png', '/assets/s/a.png'],
    )
})

test('extractArgsPaths: 去重保序 + 非 string/空值忽略', () => {
    assert.deepEqual(
        extractArgsPaths({ images: ['/assets/a.png', '/assets/a.png', '/assets/b.png'] }),
        ['/assets/a.png', '/assets/b.png'],
    )
    assert.deepEqual(extractArgsPaths({ path: '  ' }), [])
    assert.deepEqual(extractArgsPaths({ path: 123, url: null, images: [42] }), [])
    assert.deepEqual(extractArgsPaths({ command: 'cat src/a.ts' }), [], 'bash 的 command 不提取')
    assert.deepEqual(extractArgsPaths(null), [])
    assert.deepEqual(extractArgsPaths(undefined), [])
})

test('extractArgsPaths: string args（流式拼接的原始 JSON 串）', () => {
    assert.deepEqual(extractArgsPaths('{"path":"src/a.ts"}'), ['src/a.ts'])
    assert.deepEqual(extractArgsPaths('  {"path":"src/a.ts"}  '), ['src/a.ts'], '首尾空白')
    assert.deepEqual(extractArgsPaths('{"images":["/assets/a.png"]}'), ['/assets/a.png'])
    assert.deepEqual(extractArgsPaths('{broken'), [], '解析失败返回空')
    assert.deepEqual(extractArgsPaths('src/a.ts'), [], '非 JSON 串不扫描')
})

test('extractArgsPaths: 目录/无扩展名末段过滤（与旧正则行为对齐）', () => {
    assert.deepEqual(extractArgsPaths({ path: 'src' }), [], '目录')
    assert.deepEqual(extractArgsPaths({ path: 'src/' }), [], '带尾斜杠的目录')
    assert.deepEqual(extractArgsPaths({ path: '.' }), [])
    assert.deepEqual(extractArgsPaths({ path: '..' }), [])
    assert.deepEqual(extractArgsPaths({ path: 'Makefile' }), [], '无扩展名文件一并排除（已知取舍）')
    assert.deepEqual(extractArgsPaths({ path: '.env' }), ['.env'], 'dotfile 保留')
    assert.deepEqual(extractArgsPaths({ path: 'src/a.ts' }), ['src/a.ts'])
})

test('extractArgsPaths: trim + "./" 前缀归一', () => {
    assert.deepEqual(extractArgsPaths({ path: ' src/a.ts ' }), ['src/a.ts'])
    assert.deepEqual(extractArgsPaths({ path: './src/a.ts' }), ['src/a.ts'])
    assert.deepEqual(extractArgsPaths({ path: '.\\src\\a.ts' }), ['src\\a.ts'], '去 .\\ 前缀，分隔符保留（下游内部归一）')
})

// ─── 路径形态判定 ─────────────────────────

test('isWebUrl: scheme:// 判定，Windows 盘符冒号不误判', () => {
    assert.equal(isWebUrl('https://a.com/b'), true)
    assert.equal(isWebUrl('wss://a.com'), true)
    assert.equal(isWebUrl('D:/pics/img.png'), false, 'D:/ 无 //')
    assert.equal(isWebUrl('/assets/a.png'), false)
    assert.equal(isWebUrl('src/a.ts'), false)
})

test('isAssetUrl', () => {
    assert.equal(isAssetUrl('/assets/session/a.png'), true)
    assert.equal(isAssetUrl('/assetsfoo'), false)
    assert.equal(isAssetUrl('D:\\assets\\a.png'), false)
})

test('isAbsolutePath: Windows 盘符/UNC/Unix', () => {
    assert.equal(isAbsolutePath('C:\\x\\y.ts'), true)
    assert.equal(isAbsolutePath('C:/x/y.ts'), true)
    assert.equal(isAbsolutePath('\\\\srv\\share\\f'), true)
    assert.equal(isAbsolutePath('/home/u/f.ts'), true)
    assert.equal(isAbsolutePath('src/a.ts'), false)
    assert.equal(isAbsolutePath('C:x.ts'), false, '盘符相对路径不算绝对')
})

// ─── 分隔符归一 / workspace 相对化 ─────────────────────────

test('toSlash / joinPath', () => {
    assert.equal(toSlash('D:\\ws\\sub\\a.ts'), 'D:/ws/sub/a.ts')
    assert.equal(joinPath('D:\\ws\\', 'src\\a.ts'), 'D:/ws/src/a.ts')
    assert.equal(joinPath('/home/u/ws', '/a.ts'), '/home/u/ws/a.ts')
    assert.equal(joinPath('', 'a.ts'), 'a.ts')
})

test('toWorkspaceRelative: workspace 内→相对，外→null，盘符忽略大小写', () => {
    assert.equal(toWorkspaceRelative('D:\\ws', 'D:/ws/sub/a.ts'), 'sub/a.ts')
    assert.equal(toWorkspaceRelative('D:\\ws\\', 'D:/ws/a.ts'), 'a.ts', 'root 带尾斜杠')
    assert.equal(toWorkspaceRelative('d:/ws', 'D:/WS/sub/a.ts'), 'sub/a.ts', 'Windows 大小写不敏感')
    assert.equal(toWorkspaceRelative('/home/u/ws', '/home/u/ws/f.ts'), 'f.ts')
    assert.equal(toWorkspaceRelative('/home/u/ws', '/home/u/ws2/f.ts'), null, '前缀不能只按字符匹配')
    assert.equal(toWorkspaceRelative('D:\\ws', 'E:/other/a.ts'), null)
    assert.equal(toWorkspaceRelative('D:\\ws', 'D:\\ws'), null, '根本身不是文件')
    assert.equal(toWorkspaceRelative('', 'a.ts'), null)
})

// ─── repo 定位 / diff 模式 ─────────────────────────

test('findRepoFor: 最长前缀匹配，路径段边界', () => {
    const repos = [{ path: '.' }, { path: 'packages\\app' }, { path: 'packages/app/core' }]
    assert.equal(findRepoFor('packages/app/core/src/a.ts', repos), 'packages/app/core')
    assert.equal(findRepoFor('packages/app/src/a.ts', repos), 'packages\\app')
    assert.equal(findRepoFor('other/a.ts', repos), '.')
    assert.equal(findRepoFor('packages/app2/x', [{ path: 'packages/app' }]), null, 'app2 不是 app 的子路径')
    assert.equal(findRepoFor('other/a.ts', [{ path: 'packages/app' }]), null)
    assert.equal(findRepoFor('packages/app/core', [{ path: 'packages/app/core' }]), 'packages/app/core')
})

test('toRepoRelative', () => {
    assert.equal(toRepoRelative('.', 'src/a.ts'), 'src/a.ts')
    assert.equal(toRepoRelative('packages/app', 'packages/app/src/a.ts'), 'src/a.ts')
    assert.equal(toRepoRelative('packages\\app', 'packages/app/src/a.ts'), 'src/a.ts')
})

test('pickDiffMode: untracked → unstaged → staged，干净返回 null', () => {
    const status = {
        staged: [{ path: 's.ts' }],
        unstaged: [{ path: 'm.ts' }],
        untracked: [{ path: 'n.ts' }],
    }
    assert.equal(pickDiffMode(status, 'n.ts'), 'untracked')
    assert.equal(pickDiffMode(status, 'm.ts'), 'unstaged')
    assert.equal(pickDiffMode(status, 's.ts'), 'staged')
    assert.equal(pickDiffMode(status, 'clean.ts'), null, '文件干净无 diff 可看')
})

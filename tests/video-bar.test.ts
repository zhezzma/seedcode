import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8')

test('视频状态条挂载到输入框上方 dock 区（music-bar 之后 taskbar 之前）', () => {
    const dock = read('src/components/chat/ChatDockArea.vue')
    assert.match(dock, /import VideoBar from '\.\/VideoBar\.vue'/)
    assert.match(dock, /id: 'video-bar', order: 15, component: VideoBar/)

    const bar = read('src/components/chat/VideoBar.vue')
    // 状态条显隐走 barVisible（有数据且未被 X 关闭），与 MusicBar 同语义
    assert.match(bar, /v-if="video\.barVisible\.value"/)
    // 展示序走排序 computed（运行中置顶 + 活动倒序，复用 sortMusicTasks）
    assert.match(bar, /v-for="task in video\.sortedVideos\.value"/)
    // 与其他 dock widget 同一形态：同外壳 + inline 展开（非浮出弹层）
    assert.match(bar, /border-t border-base-300 bg-base-100\/40 px-4 py-1 text-xs select-none/)
    assert.match(bar, /v-if="video\.panelOpen\.value" class="flex flex-col gap-1 pb-1\.5 pt-1 max-h-64 overflow-y-auto"/)
    assert.ok(!bar.includes('absolute'), '展开清单必须 inline，不得浮出定位')
    assert.ok(!bar.includes('z-50'), '无浮层无 z-index')
    // 面板要素：相机图标 + 状态徽标 + 停止按钮（仅 working）+ X 关闭钮
    assert.match(bar, /VideoCameraIcon/)
    assert.match(bar, /chat\.videoBar\.status\.'/)
    assert.match(bar, /v-if="task\.status === 'working'"/)
    assert.match(bar, /@click="video\.dismissBar\(\)"/)
    // 停止按钮经 stopVideo（video-gen stop 路由）
    assert.match(bar, /@click="stopVideo\(task\.taskId\)"/)
})

test('useVideoGen：三到达线单例（ext.video_state 写入口 + stop 按钮线）', () => {
    const composable = read('src/composables/useVideoGen.ts')
    // 数据源为模块级单例 + detached scope（useMusicGen 同模式）
    assert.match(composable, /effectScope\(true\)/)
    assert.match(composable, /let shared: ReturnType<typeof buildVideoGenState> \| undefined/)
    // 推送线 + 快照线：ext.video_state（两仓契约，与服务端 VIDEO_STATE_EVENT 同值）
    assert.match(composable, /onExtensionEvent\('ext\.video_state', listener\)/)
    // 载荷形状守卫（防脏数据进面板）
    assert.match(composable, /export function isVideoStatePayload/)
    // 按钮线：stop 路由（/api/extensions/video-gen/sessions/:key/video/:taskId/stop），
    // 响应带回新清单直接 applyVideos
    assert.match(composable, /\/api\/extensions\/video-gen\/sessions\/\$\{encodeURIComponent\(key\)\}\/video\/\$\{encodeURIComponent\(taskId\)\}\/stop/)
    assert.match(composable, /if \(Array\.isArray\(res\?\.videos\)\) applyVideos\(res\.videos, key\)/)
    // X 关闭记忆跨刷新持久：video-bar: 前缀 + seen 名单 + activityAt 快照
    assert.match(composable, /localStorage\.getItem\(PANEL_PREFIX \+ sessionKey\)/)
    assert.match(composable, /PANEL_PREFIX = 'video-bar:'/)
    // 展示序复用音乐排序泛型函数（working 置顶 + 最近活动倒序）
    assert.match(composable, /import \{ sortMusicTasks \} from '\.\.\/utils\/music-tasks-sort'/)
    assert.match(composable, /sortMusicTasks\(videos\.value\)/)
})

test('视频回执气泡接线（解析 → DisplayBlock → 卡片）', () => {
    const messages = read('src/composables/useChatMessages.ts')
    assert.match(messages, /'subagent-report' \| 'music-report' \| 'video-report'/)
    assert.match(messages, /import \{ parseVideoReport \} from '\.\.\/utils\/videoReport\.ts'/)
    // user 输入的回执解析为 video-report 块（对位 music-report 的独立回执泡）
    assert.match(messages, /type: 'video-report',/)
    assert.match(messages, /videoStatus: videoReport\.status/)
    // 播放地址必须过 resolveMediaUrl 拼 apiBaseUrl（音乐回执同款规则）
    assert.match(messages, /videoUrl: resolveMediaUrl\(videoReport\.url, settings\.apiBaseUrl\)/)

    const bubble = read('src/components/chat/MessageBubble.vue')
    assert.match(bubble, /block\.type === 'video-report'/)
    assert.match(bubble, /chat\.videoReport\.title/)
    // 卡内常驻 <video> 原生控件（折叠只卸载正文，播放不中断）；@play 全局单播
    assert.match(bubble, /<video v-if="block\.videoUrl" :src="block\.videoUrl" controls preload="metadata" playsinline/)
    assert.match(bubble, /data-video-report/)
    assert.match(bubble, /@play="onVideoReportPlay"/)
    // 失败带 taskId 脚注（可折叠正文）
    assert.match(bubble, /v-if="block\.videoTaskId"/)
})

test('全局单播选择器纳入视频回执卡（chat-media 单点集中）', () => {
    const chatMediaSource = read('src/utils/chat-media.ts')
    assert.match(chatMediaSource, /'\.markdown-body audio, \.markdown-body video, audio\[data-music-audio\], video\[data-video-report\]'/)
})

test('ext.video_report WS 通知触发 settled 刷新（与 ext.music_report 同门禁）', () => {
    const state = read('src/composables/useChatState.ts')
    assert.match(state, /event === 'ext\.video_report'/)
    // 门禁三连：会话已打开 + 无活跃 SSE（流中回显走流内落位）+ refreshSettledMessages
    assert.match(state, /event === 'ext\.video_report'\r?\n            && state\.sessionsMap\.has\(sessionId\)\r?\n            && !sseConnections\.has\(sessionId\)/)
})

test('i18n 词条齐全（videoBar/videoReport，zh/en 同构）', () => {
    for (const file of ['src/i18n/zh.ts', 'src/i18n/en.ts']) {
        const s = read(file)
        assert.match(s, /videoBar: \{/, file)
        assert.match(s, /videoReport: \{/, file)
        for (const key of ['title', 'stop', 'dismissHint', 'status']) {
            assert.ok(new RegExp(`videoBar: \\{[\\s\\S]*?${key}:`).test(s), `${file} videoBar.${key}`)
        }
        // 锚定 videoBar 块：全文件匹配会被先出现的 musicBar.status 满足
        const videoBarBlock = /videoBar: \{[\s\S]*?\n {8}\},/.exec(s)?.[0] ?? ''
        assert.ok(videoBarBlock, `${file} videoBar 块`)
        for (const status of ['working', 'completed', 'error', 'aborted']) {
            assert.ok(new RegExp(`status: \\{[\\s\\S]*?${status}:`).test(videoBarBlock), `${file} videoBar.status.${status}`)
        }
        assert.match(s, /videoAttachmentRejected: "/, file)
        for (const key of ['title', 'completed', 'error']) {
            assert.ok(new RegExp(`videoReport: \\{[\\s\\S]*?${key}:`).test(s), `${file} videoReport.${key}`)
        }
        // /videobar 无任务的 toast 文案（home.noVideoTasks）
        assert.match(s, /noVideoTasks: '/)
    }
})

test('/videobar 客户端命令接线（注册表 + HomeView 拦截分支，musicbar 同模式）', () => {
    const registry = read('src/composables/clientCommands.ts')
    // 注册表：prefix 拦截（参数被忽略）
    assert.match(registry, /\{ name: 'videobar', description: '[^']*', source: 'client', dropdownLabel: '[^']*', intercept: 'prefix' \}/)

    const home = read('src/views/HomeView.vue')
    // HomeView：数据源实例 + 拦截分支（正则字面量被注册表↔HomeView 对齐测试锚定）
    assert.match(home, /import \{ useVideoGen \} from '\.\.\/composables\/useVideoGen'/)
    assert.match(home, /const videoGenState = useVideoGen\(\)/)
    assert.match(home, /const videoBarCommand = \/\^\\\/videobar\(\?:\\s\|\$\)\/i\.test\(inputText\)/)
    assert.match(home, /if \(!videoGenState\.togglePanel\(\)\) \{[\s\S]*?useToast\(\)\.info\(t\('home\.noVideoTasks'\)\)/)
})

test('视频附件拦截：addAttachment 开头守卫 video/*（不再按文本读取）', () => {
    const input = read('src/composables/useChatInput.ts')
    assert.match(input, /if \(isVideoFile\(file\)\) \{/)
    // MIME 优先、空 MIME 按扩展名兜底
    assert.match(input, /file\.type\.startsWith\('video\/'\) \|\| \(!file\.type && VIDEO_EXT_RE\.test\(file\.name\)\)/)
    // 提示文案走 i18n（指路工作区路径引用，generate_video 的素材地址语义）
    assert.match(input, /i18n\.global\.t\('chat\.videoAttachmentRejected'\)/)
    // 粘贴路径同口径交给 addAttachment（不静默丢弃）
    const chatInput = read('src/components/chat/ChatInput.vue')
    assert.match(chatInput, /if \(item\.type\.startsWith\('video\/'\)\) \{/)
})

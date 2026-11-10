import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sortMusicTasks } from '../src/utils/music-tasks-sort.ts'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8')

test('音乐状态条挂载到输入框上方 dock 区（bg-agents 之后 taskbar 之前）', () => {
    const dock = read('src/components/chat/ChatDockArea.vue')
    assert.match(dock, /import MusicBar from '\.\/MusicBar\.vue'/)
    assert.match(dock, /id: 'music-bar', order: 14, component: MusicBar/)

    const bar = read('src/components/chat/MusicBar.vue')
    // 状态条显隐走 barVisible（有数据且未被 X 关闭），与 BgAgentsBar 同语义
    assert.match(bar, /v-if="music\.barVisible\.value"/)
    // 展示序走排序 computed（运行中置顶 + 活动倒序）
    assert.match(bar, /v-for="task in music\.sortedMusics\.value"/)
    // 与其他 dock widget 同一形态：同外壳 + inline 展开（非浮出弹层）
    assert.match(bar, /border-t border-base-300 bg-base-100\/40 px-4 py-1 text-xs select-none/)
    assert.match(bar, /v-if="music\.panelOpen\.value" class="flex flex-col gap-1 pb-1\.5 pt-1 max-h-64 overflow-y-auto"/)
    assert.ok(!bar.includes('absolute'), '展开清单必须 inline，不得浮出定位')
    assert.ok(!bar.includes('z-50'), '无浮层无 z-index')
    // 面板要素：状态徽标 + 停止按钮（仅 working）+ X 关闭钮；无轨迹入口（音乐无轨迹数据）
    assert.match(bar, /chat\.musicBar\.status\.'/)
    assert.match(bar, /v-if="task\.status === 'working'"/)
    assert.match(bar, /@click="music\.dismissBar\(\)"/)
    assert.ok(!bar.includes('useSubagentTrace'), '无轨迹抽屉接线')
    // 停止按钮经 stopMusic（audio-gen stop 路由）
    assert.match(bar, /@click="stopMusic\(task\.taskId\)"/)
})

test('useMusicGen：三到达线单例（ext.music_state 写入口 + stop 按钮线）', () => {
    const composable = read('src/composables/useMusicGen.ts')
    // 数据源为模块级单例（与 useBackgroundAgents 同模式）
    assert.match(composable, /let shared: ReturnType<typeof buildMusicGenState> \| undefined/)
    // 推送线 + 快照线：ext.music_state（两仓契约，与服务端 MUSIC_STATE_EVENT 同值）
    assert.match(composable, /onExtensionEvent\('ext\.music_state', listener\)/)
    // 载荷形状守卫（防脏数据进面板）
    assert.match(composable, /export function isMusicStatePayload/)
    // 按钮线：stop 路由（/api/extensions/audio-gen/sessions/:key/music/:taskId/stop），
    // 响应带回新清单直接 applyMusics
    assert.match(composable, /\/api\/extensions\/audio-gen\/sessions\/\$\{encodeURIComponent\(key\)\}\/music\/\$\{encodeURIComponent\(taskId\)\}\/stop/)
    assert.match(composable, /if \(Array\.isArray\(res\?\.musics\)\) applyMusics\(res\.musics, key\)/)
    // /musicbar 命令入口：无任务返 false（调用方 toast）；被 X 关掉时先恢复显示并落盘
    assert.match(composable, /if \(musics\.value\.length === 0\) return false/)
    assert.match(composable, /if \(panelMem\.value\.dismissed\) persistPanel\(\{ dismissed: false \}\)/)
    // X 关闭记忆跨刷新持久：seen 名单 + activityAt 快照（BgAgentsBar 同解法）
    assert.match(composable, /localStorage\.getItem\(PANEL_PREFIX \+ sessionKey\)/)
    assert.match(composable, /ids\.some\(id => !panelMem\.value\.seen\.includes\(id\)\)/)
    assert.match(composable, /const barVisible = computed\(\(\) => hasMusics\.value && !panelMem\.value\.dismissed\)/)
    // 切会话/刷新：记忆按会话键从盘上取回；immediate 保证快照到达前就位
    assert.match(composable, /panelMem\.value = key \? loadPanelMemory\(key\) : \{ seen: \[\], dismissed: false \}/)
})

test('音乐回执气泡接线（解析 → DisplayBlock → 卡片）', () => {
    const messages = read('src/composables/useChatMessages.ts')
    assert.match(messages, /'subagent-report' \| 'music-report'/)
    assert.match(messages, /import \{ parseMusicReport \} from '\.\.\/utils\/musicReport\.ts'/)
    // user 输入的回执解析为 music-report 块（对位 subagent-report 的独立回执泡）
    assert.match(messages, /type: 'music-report',/)
    assert.match(messages, /musicStatus: musicReport\.status/)
    // 播放键地址必须过 resolveMediaUrl 拼 apiBaseUrl（图片块同款规则）：服务端注入
    // /assets 相对地址，Tauri 壳的 webview origin 是 tauri://localhost，裸相对链接
    // 解析成死链（客户端点播放键打不开）
    assert.match(messages, /musicUrl: resolveMediaUrl\(musicReport\.url, settings\.apiBaseUrl\)/)

    const bubble = read('src/components/chat/MessageBubble.vue')
    assert.match(bubble, /block\.type === 'music-report'/)
    assert.match(bubble, /chat\.musicReport\.title/)
    // 完成带原地播放键（播放/暂停切换，不跳浏览器）；失败带 taskId 脚注。
    // 卡内真 <audio> 元素：VirtualMessageList 的播放中行保活按 audio/video 通用
    // 检测（!paused 即保持挂载，离屏不掐断，滚动回来进度/播放态原样保留）。
    // ref 必须用函数形式：块在 v-for 内，字符串 ref 会被 Vue 收集成数组
    // （ref_for: true → setupState[ref] = [el]），el.paused undefined / el.pause()
    // TypeError——点击无声的回归锚
    assert.match(bubble, /<audio v-if="block\.musicUrl" :ref="assignMusicAudioEl" :src="block\.musicUrl" preload="metadata"/)
    assert.match(bubble, /const assignMusicAudioEl = \(el: Element \| ComponentPublicInstance \| null\) => \{/)/
    assert.match(bubble, /musicAudioEl\.value = el instanceof HTMLAudioElement \? el : null/)
    assert.match(bubble, /data-music-audio @play="onMusicPlay"/)
    // @click.stop：头部现承担折叠开合，播放键不得冒泡触发开合
    assert.match(bubble, /v-if="block\.musicUrl" type="button" @click\.stop="toggleMusicAudio"/)
    assert.match(bubble, /<PauseIcon v-if="musicPlaying" class="h-3\.5 w-3\.5" \/>/)
    assert.match(bubble, /<PlayIcon v-else class="h-3\.5 w-3\.5" \/>/)
    // 全局单播：新播放经 chat-media 单点暂停其他聊天媒体（markdown 内嵌 + 其他音乐卡）
    assert.match(bubble, /pauseOtherChatMedia\(musicAudioEl\.value\)/)
    assert.match(bubble, /v-if="block\.musicTaskId"/)
})

test('ext.music_report WS 通知触发 settled 刷新（与 ext.subagent_report 同门禁）', () => {
    const state = read('src/composables/useChatState.ts')
    assert.match(state, /event === 'ext\.music_report'/)
    // 门禁三连：会话已打开 + 无活跃 SSE（流中回显走流内落位）+ refreshSettledMessages
    assert.match(state, /event === 'ext\.music_report'\r?\n            && state\.sessionsMap\.has\(sessionId\)\r?\n            && !sseConnections\.has\(sessionId\)/)
})

test('i18n 词条齐全（musicBar/musicReport，zh/en 同构）', () => {
    for (const file of ['src/i18n/zh.ts', 'src/i18n/en.ts']) {
        const s = read(file)
        assert.match(s, /musicBar: \{/, file)
        assert.match(s, /musicReport: \{/, file)
        for (const key of ['title', 'stop', 'dismissHint', 'status']) {
            assert.ok(s.includes(`musicBar`) && new RegExp(`musicBar: \\{[\\s\\S]*?${key}:`).test(s), `${file} musicBar.${key}`)
        }
        for (const status of ['working', 'completed', 'error', 'aborted']) {
            assert.ok(new RegExp(`status: \\{[\\s\\S]*?${status}:`).test(s), `${file} musicBar.status.${status}`)
        }
        for (const key of ['title', 'completed', 'error', 'play', 'pause']) {
            assert.ok(new RegExp(`musicReport: \\{[\\s\\S]*?${key}:`).test(s), `${file} musicReport.${key}`)
        }
        // /musicbar 无任务的 toast 文案（home.noMusicTasks，bgagents 同模式）
        assert.match(s, /noMusicTasks: '/)
    }
})

test('/musicbar 客户端命令接线（注册表 + HomeView 拦截分支，bgagents 同模式）', () => {
    const registry = read('src/composables/clientCommands.ts')
    // 注册表：prefix 拦截（参数被忽略）
    assert.match(registry, /\{ name: 'musicbar', description: '[^']*', source: 'client', dropdownLabel: '[^']*', intercept: 'prefix' \}/)

    const home = read('src/views/HomeView.vue')
    // HomeView：数据源实例 + 拦截分支（正则字面量被注册表↔HomeView 对齐测试锚定）
    assert.match(home, /import \{ useMusicGen \} from '\.\.\/composables\/useMusicGen'/)
    assert.match(home, /const musicGenState = useMusicGen\(\)/)
    assert.match(home, /const musicBarCommand = \/\^\\\/musicbar\(\?:\\s\|\$\)\/i\.test\(inputText\)/)
    assert.match(home, /if \(!musicGenState\.togglePanel\(\)\) \{[\s\S]*?useToast\(\)\.info\(t\('home\.noMusicTasks'\)\)/)
})

test('sortMusicTasks：运行中置顶 + 最近活动倒序（bg-agents 同规则）', () => {
    const now = 1000
    const list = [
        { status: 'completed', lastActivityAt: now - 50, taskId: 'a' },
        { status: 'working', lastActivityAt: now - 100, taskId: 'b' },
        { status: 'error', lastActivityAt: now, taskId: 'c' },
        { status: 'aborted', taskId: 'd' },
        { status: 'working', lastActivityAt: now - 10, taskId: 'e' },
    ]
    assert.deepEqual(sortMusicTasks(list).map(x => x.taskId), ['e', 'b', 'c', 'a', 'd'])
    // 原序不被修改（纯函数）
    assert.equal(list[0]!.taskId, 'a')
})

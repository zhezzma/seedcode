import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sortBackgroundAgents } from '../src/utils/background-agents-sort.ts'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const repoRoot = path.resolve(__dirname, '..')
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8')

test('后台子代理入口统一到输入框上方 dock 区（ChatHeader 顶栏按钮已移除）', () => {
    // dock 注册：BgAgentsBar 排在 pending-queue 之后 taskbar 之前
    const dock = read('src/components/chat/ChatDockArea.vue')
    assert.match(dock, /import BgAgentsBar from '\.\/BgAgentsBar\.vue'/)
    assert.match(dock, /id: 'bg-agents', order: 12, component: BgAgentsBar/)

    // ChatHeader 剪净：顶栏按钮/面板/数据源逻辑整体迁走，不留孤儿
    const header = read('src/components/chat/ChatHeader.vue')
    assert.ok(!header.includes('UserGroupIcon'), '顶栏群组图标已删')
    assert.ok(!header.includes('bgPanelRef'), '面板 ref 已删')
    assert.ok(!header.includes('useBackgroundAgents'), '数据源消费移至 BgAgentsBar')
    assert.ok(!header.includes('useSubagentTrace'), '轨迹抽屉调用移至 BgAgentsBar')
    assert.ok(!header.includes('chat.backgroundAgents.title'), '模板不再引用面板文案')

    const bar = read('src/components/chat/BgAgentsBar.vue')
    // 状态条显隐走 barVisible（有数据且未被 X 关闭），与 TaskBar/GoalBar 的 dismiss 同语义
    assert.match(bar, /v-if="bg\.barVisible\.value"/)
    // 展示序走排序 computed（运行中置顶 + 活动倒序），不直接 v-for 裸序（服务端 Record 插入序）
    assert.match(bar, /v-for="agent in bg\.sortedAgents\.value"/)
    // 与其他 dock widget 同一形态：同外壳 + inline 展开（非浮出弹层）
    assert.match(bar, /border-t border-base-300 bg-base-100\/40 px-4 py-1 text-xs select-none/)
    assert.match(bar, /mx-auto w-full max-w-3xl/)
    assert.match(bar, /v-if="bg\.panelOpen\.value" class="flex flex-col gap-1 pb-1\.5 pt-1 max-h-64 overflow-y-auto"/)
    assert.match(bar, /rounded-lg border border-base-300 bg-base-200 px-2 py-1/)
    assert.ok(!bar.includes('absolute'), '展开清单必须 inline，不得浮出定位')
    assert.ok(!bar.includes('z-50'), '无浮层无 z-index')
    // 面板要素：状态徽标 + 眼睛（轨迹抽屉）+ 停止按钮 + X 关闭钮（同 TaskBar 折叠条模式）
    assert.match(bar, /chat\.backgroundAgents\.status\.'/)
    assert.match(bar, /subagentTrace\.title/)
    assert.match(bar, /chat\.backgroundAgents\.stop/)
    assert.match(bar, /chat\.backgroundAgents\.dismissHint/)
    assert.match(bar, /@click="bg\.dismissBar\(\)"/)
    // 数据源为模块级单例（与切会话清空/推送线共享同一份状态）
    assert.match(read('src/composables/useBackgroundAgents.ts'), /let shared: ReturnType<typeof buildBackgroundAgentsState> \| undefined/)
})

test('后台条 X 关闭钮语义：关闭跨刷新持久，新工人/命令自动恢复（TaskBar panel 同模式）', () => {
    const composable = read('src/composables/useBackgroundAgents.ts')
    // 关闭记忆按会话键持久化：刷新后仍保持关闭（此前内存态一刷新就丢）
    assert.match(composable, /localStorage\.getItem\(PANEL_PREFIX \+ sessionKey\)/)
    assert.match(composable, /localStorage\.setItem\(PANEL_PREFIX \+ sessionKey, JSON\.stringify\(mem\)\)/)
    // seen 名单防「刷新后快照全员到达被误判为新 spawn 而复活已关状态」（TaskBar seen 同解法）
    assert.match(composable, /names\.some\(n => !panelMem\.value\.seen\.includes\(n\)\)/)
    assert.match(composable, /const barVisible = computed\(\(\) => hasAgents\.value && !panelMem\.value\.dismissed\)/)
    // /bgagents 命令先把关掉的状态条拉回来（同步落盘）
    assert.match(composable, /if \(panelMem\.value\.dismissed\) persistPanel\(\{ dismissed: false \}\)/)
    // 切会话/刷新：记忆按会话键从盘上取回；immediate 保证快照到达前就位
    assert.match(composable, /panelMem\.value = key \? loadPanelMemory\(key\) : \{ seen: \[\], dismissed: false \}/)
    assert.match(composable, /\{ immediate: true \}/)
    // 模式对齐：TaskBar / GoalBar 本就有 dismiss X，后台条加入同一惯例
    assert.match(read('src/components/chat/TaskBar.vue'), /chat\.taskBar\.dismissHint/)
    assert.match(read('src/components/chat/GoalBar.vue'), /chat\.goalBar\.dismissHint/)
})

test('X 关闭后 send 唤醒已见工人恢复显示：恢复判据必须单调（lastActivityAt），不得依赖瞬时 working 帧', () => {
    const composable = read('src/composables/useBackgroundAgents.ts')
    // dismissed 落盘时记各工人活动时间戳快照（之后新活动的判别基准）
    assert.match(composable, /activityAt\?: Record<string, number>/)
    assert.match(composable, /dismissBar[\s\S]*?activityAt: Object\.fromEntries/)
    // 恢复条件二选一：未见新名字（spawn）或任一工人 lastActivityAt 超过 dismiss 快照。
    // 关键：不能用「status === working」做判据——working 是瞬时状态帧，WS 断连/SSE
    // 关闭期会丢帧，send 后只剩 completed 帧到达时 working 判据永不触发（dock 不复活）；
    // lastActivityAt 在 send 登记 / settle 时都被服务端刷新，任何一帧都能判定
    assert.match(composable, /next\.some\(a => \(a\.lastActivityAt \?\? 0\) > \(panelMem\.value\.activityAt\?\.\[a\.name\] \?\? 0\)\)/)
    // 解析兼容：盘上记忆保留 activityAt（老数据无此键 → undefined，判据退化可接受）
    assert.match(composable, /!!parsed\.activityAt && typeof parsed\.activityAt === 'object'/)
})

test('/bgagents 客户端命令：切换面板显隐，显隐状态在单例与 bar 同源', () => {
    // 注册表：/ 补全与「命令」下拉两处自动可见；busy 期拦截放行（纯 UI，工人跑着时最需要看）
    const registry = read('src/composables/clientCommands.ts')
    assert.match(registry, /name: 'bgagents', description: '后台子代理面板', source: 'client'/)
    assert.match(registry, /dropdownLabel: '\/bgagents \(后台子代理面板\)', intercept: 'prefix'/)

    // HomeView 拦截分支：清输入 + togglePanel（空时 toast）；与 busy-send-pills 对齐测试锚定
    const homeView = read('src/views/HomeView.vue')
    assert.ok(homeView.includes('/^\\/bgagents'), '/bgagents 命令拦截正则应存在')
    assert.match(homeView, /bgAgentsState\.togglePanel\(\)/)
    assert.match(homeView, /home\.noBackgroundAgents/)

    // 单例提供共享面板状态：togglePanel 空时返 false；切会话随 agents 一并收起
    const composable = read('src/composables/useBackgroundAgents.ts')
    assert.match(composable, /const sortedAgents = computed/)
    assert.match(composable, /function togglePanel\(\): boolean \{/)
    assert.match(composable, /panelOpen\.value = !panelOpen\.value/)
    assert.match(composable, /panelOpen\.value = false/)

    // bar 消费共享状态（不再自持 showPanel）：chip 点击 → toggle；inline 展开无外点关闭
    //（与其他 dock widget 行为一致，仅 toggle 切换）
    const bar = read('src/components/chat/BgAgentsBar.vue')
    assert.match(bar, /@click="bg\.togglePanel\(\)"/)
    assert.ok(!bar.includes('onClickOutside'), 'inline 展开不走外点关闭（同排队条）')
    assert.ok(!bar.includes('showPanel'), '面板显隐必须走单例 panelOpen，不得自持本地 ref')
})

test('sortedAgents：运行中置顶，其余按最近活动倒序（刚完成的贴着运行区）', () => {
    // 纯函数直测（utils 无依赖，pending-queue.test.ts 同款形态）；composable 侧仅守接线
    const composable = read('src/composables/useBackgroundAgents.ts')
    assert.match(composable, /computed\(\(\) => sortBackgroundAgents\(agents\.value\)\)/)

    const order = sortBackgroundAgents([
        { name: 'old-done', status: 'completed', lastActivityAt: 1000 },
        { name: 'new-done', status: 'error', lastActivityAt: 3000 },
        { name: 'slow-working', status: 'working' },
        { name: 'newer-working', status: 'working', lastActivityAt: 5000 },
        { name: 'idle-no-ts', status: 'idle' },
    ] as any[]).map(a => a.name)
    // working 两个在前（互之间按活动倒序）；其余按活动倒序，无时间戳的垫底
    assert.deepEqual(order, ['newer-working', 'slow-working', 'new-done', 'old-done', 'idle-no-ts'])
    // 入参不被变异（readonly 纯函数）
    const input = [{ name: 'a', status: 'working', lastActivityAt: 2 }, { name: 'b', status: 'completed', lastActivityAt: 9 }]
    sortBackgroundAgents(input)
    assert.deepEqual(input.map(a => a.name), ['a', 'b'])
})

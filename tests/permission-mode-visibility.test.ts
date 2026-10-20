import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==================== permission-gate 选择框显隐接线 ====================
//
// 服务端 permission-gate 扩展 GET /status?agent=<id> 返回 { enabled }（agent 视图：
// 装载态 ∪ 全局∪agent 级禁用）；扩展未启用时输入栏的权限选择框整体隐藏。
// 注：ChatInput.vue 依赖 vue/router 单例，无法在 node 环境 import，
// 沿用源码结构断言模式（同 notify-state-wiring.test.ts）。

const repoRoot = path.resolve(__dirname, '..')
const composableSource = readFileSync(path.join(repoRoot, 'src/composables/usePermissionMode.ts'), 'utf8')
const inputSource = readFileSync(path.join(repoRoot, 'src/components/chat/ChatInput.vue'), 'utf8')

test('可用性探测：GET /status?agent=<agentId>（两仓端点契约）', () => {
    assert.match(
        composableSource,
        /\/api\/extensions\/permission-gate\/status\?agent=/,
        '探测端点必须与服务端 GET /status 同址（改名须两仓同步）',
    )
    assert.match(
        composableSource,
        /available = ref\(false\)/,
        'fail-safe：初始态必须是不可用（扩展未启用不显示选择框）',
    )
    assert.match(
        composableSource,
        /res\?\.enabled === true/,
        'enabled 必须严格布尔判定（非布尔响应一律视为不可用）',
    )
})

test('fail-safe 收敛：确定性 404 隐藏，其余失败保持现态，乱序响应丢弃', () => {
    // 404（全局禁用挂载期门禁 / 旧服务端无路由）是确定性不可用，必须收敛为隐藏——
    // 不区分会导致「已显示 → 全局禁用后永不收敛」
    assert.match(
        composableSource,
        /e instanceof ApiError && e\.code === 404[\s\S]{0,300}available\.value = false/,
        '404 必须收敛为隐藏（ApiError.code 判定）',
    )
    // 网络抖动等未知失败不闪隐：catch 块内除 404 分支外不得置 false
    const catchIdx = composableSource.indexOf('} catch (e) {')
    assert.ok(catchIdx >= 0, 'refreshAvailability 必须有具名 catch（需区分 404）')
    const catchSlice = composableSource.slice(catchIdx, catchIdx + 700)
    const without404Branch = catchSlice.replace(
        /if \(e instanceof ApiError && e\.code === 404\) \{[\s\S]*?\n            \}/,
        '',
    )
    assert.doesNotMatch(
        without404Branch,
        /available\.value = false/,
        'catch 内除 404 分支外不得置 hidden（瞬时失败保持现态）',
    )
    // 乱序护栏：慢响应不得覆盖新探测结果
    assert.match(composableSource, /let probeSeq = 0/, '必须有探测序号护栏')
    assert.match(
        composableSource,
        /if \(seq !== probeSeq\) return/,
        '乱序响应必须丢弃（旧探测不得覆盖新判定）',
    )
})

test('显隐信号源：agent/会话切换重探 + 组件挂载重探', () => {
    assert.match(
        composableSource,
        /watch\(\s*\(\) => \[chatState\.agentsSelectedId, chatState\.sessionKey\]/,
        'agent 切换与会话切换都必须触发可用性重探',
    )
    assert.match(
        composableSource,
        /immediate: true/,
        '挂载即探测一次，不能等首次交互',
    )
    assert.match(
        composableSource,
        /function pokeAvailability\(\): void \{\s*void refreshAvailability\(chatState\.agentsSelectedId\)/,
        '必须暴露挂载重探入口（同会话往返不触发 watch，需显式补探）',
    )
    assert.match(
        inputSource,
        /permState\.pokeAvailability\(\)/,
        'ChatInput 挂载即重探：管理面开关扩展后返回聊天页显隐立即跟上',
    )
})

test('ChatInput：权限选择框 v-if=permAvailable，隐藏时清暂存档位', () => {
    // v-if 必须落在 permission 下拉的根 div 上（dropdown dropdown-top + permDropdownOpen 同节点）
    assert.match(
        inputSource,
        /<div v-if="permAvailable" class="dropdown dropdown-top"\s+:class="\{ 'dropdown-open': permDropdownOpen \}">/,
        '权限选择框整体 v-if 隐藏（不含模型/思考下拉）',
    )
    assert.match(
        inputSource,
        /watch\(permAvailable[\s\S]{0,200}pendingPermissionMode\.value = null/,
        '不可用时必须清掉创建期暂存档位，避免失效覆盖随首条消息发送',
    )
    assert.match(
        inputSource,
        /watch\(permAvailable[\s\S]{0,200}permDropdownOpen\.value = false/,
        '不可用时必须收起已开的下拉',
    )
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ==================== 子代理轨迹抽屉「运行配置」行 ====================
//
// 服务端（seedagent Task 1）提供 GET/PUT /api/extensions/subagents/sessions/:sessionId/subagents/:subId/config
// （ChildConfigView: { provider?, model?, thinkingLevel, thinkingLevels }）。抽屉给每个
// 有 subId 的 tab 加一行运行配置：模型下拉（复用 ModelSelectMenuContent + splitModelId
// 拆 provider/model）与思考档下拉（选项来自 GET 响应）；PUT 只提交改动的键。
//
// 注：SubagentTraceDrawer.vue 依赖 vue 响应性单例，无法在 node 环境 import，
// 沿用源码结构断言模式（tests/subagent-trace-wiring.test.ts 开创）。

const repoRoot = path.resolve(__dirname, '..')
const read = (file: string) => readFileSync(path.join(repoRoot, file), 'utf8')
const drawer = read('src/components/chat/SubagentTraceDrawer.vue')

test('抽屉运行配置：模型菜单复用 ModelSelectMenuContent，模型 id 用 splitModelId 拆分', () => {
    assert.match(drawer, /import ModelSelectMenuContent from '\.\.\/models\/ModelSelectMenuContent\.vue'/)
    assert.match(drawer, /import \{[^}]*splitModelId[^}]*\} from '\.\.\/\.\.\/composables\/useChatState'/)
})

test('运行配置读写走 /subagents/:subId/config，PUT 用 apiPut', () => {
    assert.match(drawer, /\/subagents\/\$\{[^}]+\}\/config`/)
    assert.match(drawer, /apiPut\(/)
})

test('PUT 404/409 内联显示服务端错误（SILENT_CODES 吞全局 toast，不能无反馈）', () => {
    const start = drawer.indexOf('async function saveRuntimeConfig')
    assert.ok(start >= 0, '未找到 saveRuntimeConfig')
    const fn = drawer.slice(start, start + 1800)
    // 响应类型注解放变量上（非 any 直赋），且不用泛型参（会破坏 apiPut\( 锚点）
    assert.match(fn, /const res: SubagentRuntimeConfig = await apiPut\(/, 'PUT 响应应有类型注解')
    assert.doesNotMatch(fn, /apiPut</, '不得用泛型参形式调 apiPut')
    // 失败分支：404/409 写内联 configError（与 GET 404 同通道），其他码留给全局 toast
    assert.match(fn, /catch \(e\)/, '应捕获错误对象（需区分错误码）')
    assert.match(fn, /e instanceof ApiError && \(e\.code === 404 \|\| e\.code === 409\)/, '应识别 ApiError 的 404/409')
    assert.match(fn, /configError\.value = e\.message/, '404/409 的服务端错误写内联提示')
})

test('saveEpoch 防线：save 发起即占代，GET 与早发 save 的晚到响应一律丢弃', () => {
    const load = drawer.slice(
        drawer.indexOf('async function loadRuntimeConfig'),
        drawer.indexOf('async function saveRuntimeConfig'),
    )
    assert.match(load, /const epoch = saveEpoch/, 'GET 发起前应快照 save 代际')
    assert.equal(
        (load.match(/if \(epoch !== saveEpoch\) return/g) ?? []).length,
        2,
        'GET 成功/失败两处都应有代际守卫',
    )
    const save = drawer.slice(drawer.indexOf('async function saveRuntimeConfig'))
    // 发起时快照语义：占代必须在 PUT 发出之前——连续两次保存时，先发者晚到的
    // 响应（成功回显或失败错误）才能被「代际已前进」判定丢弃，不覆盖后发结果
    const claimAt = save.indexOf('const epoch = ++saveEpoch')
    assert.ok(claimAt >= 0, 'save 发起时应递增并快照代际（++saveEpoch）')
    assert.ok(claimAt < save.indexOf('await apiPut('), '占代须在 PUT 发出之前')
    assert.equal(
        (save.match(/if \(epoch !== saveEpoch\) return/g) ?? []).length,
        2,
        'save 成功/失败两处都应有代际守卫（晚到的 PUT 响应丢弃）',
    )
})

test('晚到响应不写进当前 tab：load 与 save 都校验 configKey', () => {
    assert.ok((drawer.match(/configKey\.value !== key/g) ?? []).length >= 2)
})

test('档位选项来自响应；当前档位不在列表时仍显示', () => {
    assert.match(drawer, /thinkingLevels\.includes\(/)
})

test('静态模型文字已移除（会过时，与运行配置行重复）', () => {
    assert.ok(!drawer.includes('activeResult.model'))
})

test('i18n 两种语言都有运行配置文案', () => {
    for (const file of ['src/i18n/zh.ts', 'src/i18n/en.ts']) {
        assert.match(read(file), /subagentTrace:\s*\{[\s\S]*?config:\s*\{[\s\S]*?title:[\s\S]*?hint:[\s\S]*?unset:/)
    }
})

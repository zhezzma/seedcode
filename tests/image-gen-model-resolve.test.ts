import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const adaptersPath = path.resolve(testDir, '../src-tauri/resources/seedagent/dist/extensions/image-gen/images-adapters.js')
const indexPath = path.resolve(testDir, '../src-tauri/resources/seedagent/dist/extensions/image-gen/index.js')
const runtimePath = path.resolve(testDir, '../src-tauri/resources/seedagent/seedserver.mjs')
const detailPath = path.resolve(testDir, '../src/components/models/ModelDetail.vue')

/**
 * 治本回归：image-gen 扩展曾把注入条目塞进 provider 的 getAllModels()，
 * 而 GET /api/models 全量序列化该数组——用户在 models.json 里把同 id 模型设为
 * 生图类型时，管理接口返回两条同 id 条目，模型管理页 v-for :key="item.id"
 * 撞车 → Vue 补丁错乱 → 幽灵卡片。修复原则：扩展只挂 generateImages 能力、
 * 不注入全局目录；生图调用方自持构造 ImageModel 传入 Models.generateImages
 * （该入口只校验 model.type / 按 model.provider 查注册表，不查目录）。
 */

test('images-adapters: 装饰器不得注入 getAllModels（全局目录保持单一真相）', () => {
    const source = readFileSync(adaptersPath, 'utf8')
    assert.doesNotMatch(source, /getAllModels:\s*\(\)\s*=>/,
        'decorateProviderWithImages 不得覆盖 getAllModels——这会把扩展条目混进 GET /api/models')
})

test('images-adapters: images 能力挂载与实现分派保留（扩展注册 + ModelBridge 挂载）', () => {
    // 2026-10-21 dist 刷新后的接线形态：扩展不再直接装饰 provider，改经窄面桥
    // modelBridge.registerImagesCapability 提交纯函数能力（appliesTo/resolve）；
    // generateImages 方法挂载与未命中实现的报错回落移入运行时 ModelBridge
    // （applyImagesCapabilities，见 seedserver.mjs）——语义未变，实现位置变了。
    const source = readFileSync(adaptersPath, 'utf8')
    assert.match(source, /modelBridge\.registerImagesCapability\("image-gen",\s*imageGenImagesCapability\)/,
        '扩展需经窄面桥注册 images 能力（能力注入，不是目录注入）')
    assert.match(source, /export function generate(?:Openai|GeminiChat|OpenaiChat)Images\(model,\s*context,\s*options\)/,
        '适配器需保留 (model, context, options) 分派签名')

    const runtime = readFileSync(runtimePath, 'utf8')
    assert.match(runtime, /generateImages:\s*\(model,\s*context,\s*options\)\s*=>/,
        'ModelBridge.applyImagesCapabilities 需挂载 generateImages 分派')
    assert.match(runtime, /imageErrorResult\(model, `Provider \$\{provider\.id\} has no image generation implementation/,
        '未命中实现时回落/报错语义保留')
})

test('index: 生图调度不得走目录查询（getModelOfType）', () => {
    const source = readFileSync(indexPath, 'utf8')
    assert.doesNotMatch(source, /getModelOfType/,
        'dispatchGenerate 不得依赖模型目录查询——扩展条目已不进目录，应自持构造 ImageModel')
})

test('model-resolve: buildImageModel 构造完整 ImageModel（editable 输入含 image）', async () => {
    const resolveModule = await import('../src-tauri/resources/seedagent/dist/extensions/image-gen/model-resolve.js').catch(() => null)
    assert.ok(resolveModule && typeof resolveModule.buildImageModel === 'function', 'buildImageModel should exist')

    const entry = { id: 'gpt-image-2.5-sunburst', api: 'image-gen/openai-chat-images', editable: true }
    const provider = { id: 'gpt-images', baseUrl: 'http://example.com/v1/', getModels: () => [] }

    const model = resolveModule.buildImageModel(entry, provider)
    assert.equal(model.type, 'image')
    assert.equal(model.id, 'gpt-image-2.5-sunburst')
    assert.equal(model.name, 'gpt-image-2.5-sunburst')
    assert.equal(model.api, 'image-gen/openai-chat-images')
    assert.equal(model.provider, 'gpt-images')
    assert.equal(model.baseUrl, 'http://example.com/v1')          // 尾斜杠归一化
    assert.deepEqual(model.input, ['text', 'image'])              // editable → 可图生图
    assert.deepEqual(model.output, ['image'])
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('model-resolve: baseUrl 双级解析——provider 级优先，缺省回落模型级', async () => {
    const resolveModule = await import('../src-tauri/resources/seedagent/dist/extensions/image-gen/model-resolve.js').catch(() => null)
    assert.ok(resolveModule && typeof resolveModule.buildImageModel === 'function', 'buildImageModel should exist')

    const entry = { id: 'img', api: 'image-gen/openai-images', editable: false }

    // provider.baseUrl 优先
    const m1 = resolveModule.buildImageModel(entry, { id: 'p', baseUrl: 'http://a/v1', getModels: () => [{ baseUrl: 'http://b/v1' }] })
    assert.equal(m1.baseUrl, 'http://a/v1')

    // provider 级缺省 → 回落任一模型级 baseUrl（对齐旧 getApiConfig）
    const m2 = resolveModule.buildImageModel(entry, { id: 'p', getModels: () => [{ baseUrl: 'http://b/v1/' }] })
    assert.equal(m2.baseUrl, 'http://b/v1')
})

test('model-resolve: 无 baseUrl 返回 undefined（调用方负责报错提示）', async () => {
    const resolveModule = await import('../src-tauri/resources/seedagent/dist/extensions/image-gen/model-resolve.js').catch(() => null)
    assert.ok(resolveModule && typeof resolveModule.buildImageModel === 'function', 'buildImageModel should exist')

    const entry = { id: 'img', api: 'image-gen/openai-images', editable: false }
    assert.equal(resolveModule.buildImageModel(entry, { id: 'p', getModels: () => [] }), undefined)
})

test('model-resolve: 非 editable 条目输入仅 text', async () => {
    const resolveModule = await import('../src-tauri/resources/seedagent/dist/extensions/image-gen/model-resolve.js').catch(() => null)
    assert.ok(resolveModule && typeof resolveModule.buildImageModel === 'function', 'buildImageModel should exist')

    const model = resolveModule.buildImageModel(
        { id: 'img', api: 'image-gen/openai-images', editable: false },
        { id: 'p', baseUrl: 'http://a', getModels: () => [] },
    )
    assert.deepEqual(model.input, ['text'])
})

test('ModelDetail: 渲染键对齐数据身份键 (id, type)——同 id 的 chat/image 合法共存不撞 key', () => {
    const source = readFileSync(detailPath, 'utf8')
    assert.match(source, /:key="`\$\{item\.id\}:\$\{item\.type\}`"/,
        '模型卡片 v-for 键应为 `${item.id}:${item.type}`（pi-ai 模型身份键是 id+type）')
})

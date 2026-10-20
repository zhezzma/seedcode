import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const detailPath = path.resolve(testDir, '../src/components/models/ModelDetail.vue')

// 注：本文件原有针对 src-tauri/resources/seedagent/dist 打包产物的测试
// （images-adapters / index / model-resolve 共 7 个）已删除——产物目录
// gitignore，干净检出上必然失败，属结构性腐化；产物回归应由打包流水线自持。

test('ModelDetail: 渲染键对齐数据身份键 (id, type)——同 id 的 chat/image 合法共存不撞 key', () => {
    const source = readFileSync(detailPath, 'utf8')
    assert.match(source, /:key="`\$\{item\.id\}:\$\{item\.type\}`"/,
        '模型卡片 v-for 键应为 `${item.id}:${item.type}`（pi-ai 模型身份键是 id+type）')
})

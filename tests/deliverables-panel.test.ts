/**
 * DeliverablesPanel 点击分流（源码形状断言，同 music-bar 模式）：
 * 二进制不在面板单独处理——分流统一收口在 useWorkspaceViewer.openDiff
 * （按扩展名 isBinaryExt 判定，二进制改开文件预览不走 diff），面板只负责
 * 把服务端已验证的 git 目标连同删除态标记传过去。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const panel = readFileSync(path.join(repoRoot, 'src/components/chat/DeliverablesPanel.vue'), 'utf8')

test('交付物点击分流：媒体特判已移除，二进制统一由 openDiff 分流', () => {
    // 媒体白名单特判不再存在（二进制→预览的判定收口在 openDiff 内的 isBinaryExt）
    assert.doesNotMatch(panel, /mediaKindFromPath/)
    // 原有分流保持：有 git 状态 → diff；区域外/gitignore → 直接看文件
    assert.match(panel, /wsViewer\.openDiff\(\{[\s\S]*?file: item\.path/)
    assert.match(panel, /wsViewer\.openAbsolute\(item\.abs\)/)
})

test('交付物点击分流：deleted 标记透传（删除态文件不在盘上，预览必 404）', () => {
    assert.match(panel, /deleted: item\.change === 'deleted'/)
})

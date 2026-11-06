/**
 * DeliverablesPanel 点击分流（源码形状断言，同 music-bar 模式）：
 * 二进制媒体（图/音/视）直接开预览（openAbsolute → WorkspaceFileView 原生
 * <img>/<audio>/<video>），不走 diff——git 对二进制文件的 diff 只有
 * 「binary files differ」一行，无信息量。删除态除外：文件已不在，预览必 404，
 * 维持 diff（至少可见删除事实）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const panel = readFileSync(path.join(repoRoot, 'src/components/chat/DeliverablesPanel.vue'), 'utf8')

test('交付物点击分流：二进制媒体直接开预览，非媒体才走 diff', () => {
    // 媒体判定复用 mediaKindFromPath（与后端 media-whitelist 同步的清单）
    assert.match(panel, /import \{ mediaKindFromPath \} from '\.\.\/\.\.\/composables\/workspace-api'/)
    // 媒体优先分支在 diff 分支之前：非删除态的图/音/视 → openAbsolute 预览
    assert.match(
        panel,
        /if \(item\.change !== 'deleted' && mediaKindFromPath\(item\.path\)\) \{\s*\n\s*wsViewer\.openAbsolute\(item\.abs\)\s*\n\s*return\s*\n\s*\}/,
        '媒体文件必须先于 diff 分支直接开预览',
    )
    // 原有分流保持：有 git 状态 → diff；区域外/gitignore → 直接看文件
    assert.match(panel, /wsViewer\.openDiff\(\{ repo: item\.repo, mode: item\.mode, file: item\.path, ref: item\.ref \?\? undefined \}\)/)
    assert.match(panel, /wsViewer\.openAbsolute\(item\.abs\)/)
})

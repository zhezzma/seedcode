import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

test('虚拟滚动不杀播放中的媒体行（滚动后音乐继续播放）', () => {
    const source = readFileSync(path.join(repoRoot, 'src/components/chat/VirtualMessageList.vue'), 'utf8')

    // 根因锁：屏幕外的行 v-if 换成 spacer 整行卸载，<audio>/<video> 随行销毁——
    // 正在播放的音乐滚动后戛然而止。修复 = 即将离屏的行内有播放中的媒体时保持挂载
    //（离屏但不卸载；滚回来是同一个元素，进度/播放态原样保留）。
    // 检测必须在卸载前（DOM 还在）：遍历当前已挂载集合，query 行内 audio/video
    // 的 paused 属性（paused 是 DOM property，非 attribute——matches(':not([paused])')
    // 不可用，必须 instanceof HTMLMediaElement 读属性）。
    assert.match(
        source,
        /for \(const key of visibleKeys\.value\) \{\s*\n\s*if \(next\.has\(key\)\) continue\s*\n\s*const rowEl = rowEls\.get\(key\)\s*\n\s*if \(!rowEl\) continue\s*\n\s*const playing = Array\.from\(rowEl\.querySelectorAll\('audio, video'\)\)\.some\(\s*\n\s*el => el instanceof HTMLMediaElement && !el\.paused,\s*\n\s*\)\s*\n\s*if \(playing\) next\.add\(key\)\s*\n\s*\}/,
    )

    // 保活行不破坏虚拟滚动布局：行位置由前置 spacer/行高度累积决定（flex 列序），
    // 离屏只是不可见，spacer 语义（保高度稳定）不受影响
    assert.match(source, /virtual-message-list\s*\{\s*\n\s*display:\s*flex;\s*\n\s*flex-direction:\s*column;?\s*\n\s*\}/)
    assert.match(source, /\.virtual-spacer\s*\{\s*\n\s*flex-shrink:\s*0;?\s*\n\s*\}/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testDir, '..')

const readSource = (relPath: string) =>
  readFileSync(path.join(repoRoot, relPath), 'utf8')

const markdownRendererSource = readSource('src/components/chat/MarkdownRenderer.vue')
const useMediaPreviewSource = readSource('src/composables/useMediaPreview.ts')
const fileDownloadSource = readSource('src/utils/fileDownload.ts')
const enSource = readSource('src/i18n/en.ts')
const zhSource = readSource('src/i18n/zh.ts')

test('markdown 音视频链接就地升级为内嵌播放器（enhanceRenderedMedia）', () => {
  assert.match(markdownRendererSource, /const enhanceRenderedMedia = \(\) => \{/)
  // 渲染管线接线：图片包装后追加媒体升级
  assert.match(markdownRendererSource, /enhanceRenderedImages\(\)\s*\n\s*enhanceRenderedMedia\(\)/)
  // 判定复用 workspace-api 的 mediaKindFromPath（与后端 media-whitelist 同步的清单）
  assert.match(markdownRendererSource, /import \{ mediaKindFromPath \} from '\.\.\/\.\.\/composables\/workspace-api'/)
  // 原生控件 + 懒加载（preload=metadata 翻历史不拉全量字节）
  assert.match(markdownRendererSource, /document\.createElement\(kind\)/)
  assert.match(markdownRendererSource, /media\.controls = true/)
  assert.match(markdownRendererSource, /media\.preload = 'metadata'/)
  // 图片链接不内联（交给 linked-image lightbox 分支），仅 audio/video
  assert.match(markdownRendererSource, /if \(kind !== 'audio' && kind !== 'video'\) return/)
  // 视频移动端不劫持全屏
  assert.match(markdownRendererSource, /media instanceof HTMLVideoElement\) media\.playsInline = true/)
})

test('播放器宽度根因修复：音视频 wrapper 转 block（防 inline-block 循环参照塌缩）', () => {
  // 回归锁：2026-11 手机实测 audio 塌缩到 ~30px 宽、界面呈现一片空白；
  // inline-block shrink-to-fit 与 audio width:100% 循环参照是根因
  assert.match(markdownRendererSource, /wrapper\.className = 'markdown-image-preview markdown-media-preview'/)
  assert.match(markdownRendererSource, /\.markdown-body :deep\(\.markdown-media-preview\)\s*\{[\s\S]*?display:\s*block\s*;?\s*\}/)
})

test('表格内播放器塌缩修复：table 上下文 min-width（max-content 列宽的循环参照）', () => {
  // 回归锁：表格（github-markdown.css：display:block + width:max-content +
  // overflow:auto）内嵌音频不显示——td 列宽由表格 max-content 布局决定，
  // audio width:100% 的参照又回到待定态，播放器塌缩成 ~28px 竖条（用户只看到
  // 下载按钮）。display:block 的既有修复在 td 里失效（气泡内容宽参照不再到达）。
  // 修复：table 上下文给 audio/video 一个确定的 min-width 贡献，列宽得以撑起。
  // 实测：min-width:16rem 后表格内 audio 28px → 256px，表格外不受影响。
  assert.match(
    markdownRendererSource,
    /:deep\(table \.markdown-image-preview (audio|video)\)[\s\S]*?:deep\(table \.markdown-image-preview (?:audio|video)\)[\s\S]*?min-width:\s*16rem/,
  )
})

test('mediaKindFromPath 剥 query/hash：带参 URL 不漏判、伪扩展不误判', async () => {
  const { mediaKindFromPath } = await import('../src/composables/workspace-api.ts')
  // 带签名/时间戳参数：仍是 audio（修复前 null）
  assert.equal(mediaKindFromPath('/assets/audios/session/x/sound-1.mp3?token=abc'), 'audio')
  assert.equal(mediaKindFromPath('/assets/audios/session/x/sound-1.mp3#t=0'), 'audio')
  // 主路径（无参数）不受影响
  assert.equal(mediaKindFromPath('/assets/audios/session/x/sound-1.mp3'), 'audio')
  // 伪命中掐断：html 后接 ?.mp3 不是音频
  assert.equal(mediaKindFromPath('/files/evil.html?.mp3'), null)
  // 纯页内锚不被升级成播放器
  assert.equal(mediaKindFromPath('#section.mp3'), null)
  // workspace 文件路径（无 ?/#）行为不变
  assert.equal(mediaKindFromPath('docs/beep.mp3'), 'audio')
  assert.equal(mediaKindFromPath('docs/icon.png'), 'image')
  assert.equal(mediaKindFromPath('docs/notes.txt'), null)
})

test('mediaKindFromPath 全集 pin：与服务端 media-whitelist 同步的镜像清单', async () => {
  // 跨仓契约钉：服务端 seedagent/src/server/workspace/media-whitelist.ts 的
  // IMAGE_MIME（7）+ AV_MIME 音频（9）+ AV_MIME 视频（8）。服务端扩名单而前端
  // 落后时，本测试红——新增类型会退化为纯链接（预览/内嵌播放器不生效）。
  const { mediaKindFromPath } = await import('../src/composables/workspace-api.ts')
  const images = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']
  const audios = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'weba']
  const videos = ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', '3gp', '3g2']
  for (const ext of images) assert.equal(mediaKindFromPath(`/x/file.${ext}`), 'image', ext)
  for (const ext of audios) assert.equal(mediaKindFromPath(`/x/file.${ext}`), 'audio', ext)
  for (const ext of videos) assert.equal(mediaKindFromPath(`/x/file.${ext}`), 'video', ext)
  // 白名单外容器（avi）与扩展名大小写不敏感
  assert.equal(mediaKindFromPath('/x/file.avi'), null)
  assert.equal(mediaKindFromPath('/x/CLIP.MOV'), 'video')
})

test('内嵌播放器共享图片的 hover 下载按钮与包装', () => {
  // 复用 .markdown-image-preview 包装（同套 hover 下载按钮样式；叠加 media 标记类转 block）
  assert.match(markdownRendererSource, /enhanceRenderedMedia[\s\S]*?wrapper\.className = 'markdown-image-preview markdown-media-preview'/)
  // 下载按钮 handler 兼容三种元素：img 分支保持原行为，audio/video 回退 downloadMedia
  assert.match(markdownRendererSource, /downloadButton\.parentElement\?\.querySelector\('img'\)/)
  assert.match(markdownRendererSource, /downloadButton\.parentElement\?\.querySelector\('audio, video'\)/)
  assert.match(markdownRendererSource, /media instanceof HTMLMediaElement\)\s*\{\s*\n\s*downloadMedia\(media\.currentSrc \|\| media\.src\)/)
  // 精确锁两个下载函数都被解构（旧二选一 alternation 近恒真：任意顺序任意位置的子串命中即过）
  assert.match(markdownRendererSource, /const \{ openLightbox, downloadImage, downloadMedia \} = useMediaPreview\(\)/)
})

test('一次只播一个：新播放暂停会话内其他 markdown 媒体', () => {
  assert.match(markdownRendererSource, /media\.addEventListener\('play', \(\) => \{\s*\n\s*pauseOtherChatMedia\(media\)\s*\n\s*\}\)/)
  // 互斥选择器单点在 chat-media.ts（markdown 内嵌 + 音乐回执卡音频共享，防两处
  // 各自维护漂移）：document 级查询 + 两个媒体面都在选择器里，缺一面即红
  const chatMediaSource = readSource('src/utils/chat-media.ts')
  assert.match(chatMediaSource, /document\.querySelectorAll<HTMLMediaElement>\(CHAT_MEDIA_SELECTOR\)/)
  assert.match(chatMediaSource, /'\.markdown-body audio, \.markdown-body video, audio\[data-music-audio\]'/)
})

test('流式重渲染播放器保活：v-html 重写前摘下 wrapper、新 DOM 升级后移植回来', () => {
  // 回归锁：流式期间每个 chunk 都会 v-html 重写（同步/异步双发），销毁重建的
  // <audio> 重拉 metadata（时长 0:00 闪跳）、播放态闪烁、控件高度跳变——表现为
  // 播放器持续抖动。旧 DOM 节点直接移植（元素从未死亡）而非快照重建。
  assert.match(markdownRendererSource, /interface DetachedMedia \{/)
  assert.match(markdownRendererSource, /const detachMediaWrappers = \(\): DetachedMedia\[\] => \{/)
  assert.match(markdownRendererSource, /wrapper\.remove\(\)/)
  assert.match(markdownRendererSource, /fresh\.replaceWith\(old\.wrapper\)/)
  // 接线顺序：摘除必须先于 renderedHtml 赋值（旧 DOM 还在），移植在两个 enhance 之后
  assert.match(markdownRendererSource,
    /const detached = detachMediaWrappers\(\)\s*\n\s*renderedHtml\.value = resolveMarkdownResourceUrls\(html, settings\.apiBaseUrl\)\s*\n\s*await nextTick\(\)\s*\n\s*enhanceRenderedImages\(\)\s*\n\s*enhanceRenderedMedia\(\)\s*\n\s*transplantMediaWrappers\(detached\)/)
  // 快照/续接链路已删：重建元素的方式连同其闪烁根因一并退场
  assert.doesNotMatch(markdownRendererSource, /snapshotPlayingMedia/)
  assert.doesNotMatch(markdownRendererSource, /restorePlayingMedia/)
})

test('apiBaseUrl 为空时不升级播放器：保持 <a> 链接形态（死链可见可诊断）', () => {
  // 兑底语义：空 apiBaseUrl 下 href 拼不出可用绝对地址，升级成 <audio src> 只会
  // 得到指向当前 origin（tauri://localhost）的死链；链接至少可见可点。
  assert.match(markdownRendererSource, /if \(!settings\.apiBaseUrl\.trim\(\)\) return/)
})

test('播放器样式：宽度跟随气泡 + 限宽，视频圆角', () => {
  assert.match(markdownRendererSource, /\.markdown-image-preview audio\)[\s\S]*?max-width:\s*26rem/)
  assert.match(markdownRendererSource, /\.markdown-image-preview video\)[\s\S]*?max-width:\s*35rem[\s\S]*?border-radius:\s*0\.5rem/)
})

test('downloadMedia：文件名优先 URL 末段，落盘走 saveBlob，toast 用媒体文案', () => {
  assert.match(useMediaPreviewSource, /const downloadMedia = async \(src: string\) => \{/)
  assert.match(useMediaPreviewSource, /export const getMediaFileName = \(src: string, mimeType: string, fallbackPrefix = 'media'\): string => \{/)
  assert.match(useMediaPreviewSource, /const fileName = getMediaFileName\(src, blob\.type \|\| 'application\/octet-stream'\)/)
  assert.match(useMediaPreviewSource, /chat\.downloadMediaSuccess/)
  assert.match(useMediaPreviewSource, /chat\.downloadMediaFailed/)
  // 与 downloadImage 共用落盘通道
  assert.match(useMediaPreviewSource, /const downloadMedia = async[\s\S]*?saveBlob\(blob, fileName\)/)
})

test('downloadMedia/downloadImage：非 2xx 拒绝落盘，双侧防重入（回归锁）', () => {
  // 回归：修复前 404/413 的 JSON 错误体会被存成 .mp3/.png 并弹成功 toast。
  // 计数断言：两个函数各一处（旧单次 match 只锁了一处，删掉另一处不红）
  const okGuards = useMediaPreviewSource.match(/if \(!response\.ok\) throw new Error\(`HTTP \$\{response\.status\}`\)/g) ?? []
  assert.equal(okGuards.length, 2, `expected 2 response.ok guards, got ${okGuards.length}`)
  // 回归：连点会并发拉两份大文件到内存与磁盘；双侧共用进行中集合 + finally 清理
  assert.match(useMediaPreviewSource, /const activeDownloads = new Set<string>\(\)/)
  const reentryGuards = useMediaPreviewSource.match(/activeDownloads\.has\(src\)/g) ?? []
  assert.equal(reentryGuards.length, 2, 'expected reentry guards in both downloadImage and downloadMedia')
  const cleanups = useMediaPreviewSource.match(/activeDownloads\.delete\(src\)/g) ?? []
  assert.equal(cleanups.length, 2, 'expected finally cleanup in both downloadImage and downloadMedia')
  // 进行中再点不再静默 no-op：明确提示（否则 body 流悬挂期间点击无声无息）
  assert.match(useMediaPreviewSource, /downloadInProgress/)
})

test('getMediaFileName：末段带扩展名直接用（消毒分隔符），无扩展名按 MIME 兑底', async () => {
  // 行为断言（纯函数直接 import）
  const { getMediaFileName } = await import('../src/composables/useMediaPreview.ts')
  // 后端 /assets 唯一命名末段原样保留
  assert.equal(getMediaFileName('http://127.0.0.1:18789/assets/audios/session/s/sound-1-2.mp3', 'audio/mpeg'), 'sound-1-2.mp3')
  // 回归锁：URL 解码后的末段含路径分隔符（a%2F..%2F..%2Fevil.mp3）必须剥离为下划线，
  // 否则保存 API 会把它展开成 Download 目录下的路径穿越
  assert.equal(getMediaFileName('http://x/a%2F..%2F..%2Fevil.mp3', 'audio/mpeg'), 'a_.._.._evil.mp3')
  assert.equal(getMediaFileName('http://x/b%5Cevil.mp4', 'video/mp4'), 'b_evil.mp4')
  // 末段无扩展名：按 MIME 推展名 + 前缀兑底（时间戳形态）
  assert.match(getMediaFileName('http://x/media', 'audio/mpeg'), /^media-\d+-\d+\.mp3$/)
  assert.match(getMediaFileName('blob:nocache', 'video/webm'), /^media-\d+-\d+\.webm$/)
  // 非 http URL 直接兑底
  assert.match(getMediaFileName('data:audio/mpeg;base64,xxx', 'audio/mpeg'), /^media-\d+-\d+\.mp3$/)
})

test('getMediaExtension：音视频 subtype 与扩展名不一致的特判（行为断言）', async () => {
  const { getMediaExtension } = await import('../src/utils/fileDownload.ts')
  // audio/mpeg 实为 .mp3（subtype mpeg 是历史命名）；audio/mp4 实为 .m4a
  assert.equal(getMediaExtension('audio/mpeg'), 'mp3')
  assert.equal(getMediaExtension('audio/mp4'), 'm4a')
  assert.equal(getMediaExtension('audio/wav'), 'wav')
  assert.equal(getMediaExtension('video/mp4'), 'mp4')
  // 图片沿用 getImageExtension
  assert.equal(getMediaExtension('image/png'), 'png')
  // 官方 subtype 与扩展名不一致的特判（3gpp 实为 .3gp）与带连字符 subtype（x-m4a）
  assert.equal(getMediaExtension('video/3gpp'), '3gp')
  assert.equal(getMediaExtension('audio/x-m4a'), 'x-m4a')
  // 未知类型兑底 bin
  assert.equal(getMediaExtension('application/json'), 'bin')
  assert.equal(getMediaExtension(''), 'bin')
})

test('i18n：中英双语补齐媒体下载四键（含进行中提示）', () => {
  for (const source of [enSource, zhSource]) {
    assert.match(source, /downloadMedia:/)
    assert.match(source, /downloadMediaSuccess:/)
    assert.match(source, /downloadMediaFailed:/)
    assert.match(source, /downloadInProgress:/)
  }
})

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import jsQR from 'jsqr'
import { CameraIcon } from '@heroicons/vue/24/outline'

/**
 * 通用扫码弹窗：getUserMedia + jsQR 逐帧解码。
 * 不用原生 Shape Detection API——它在 iOS WebView / 部分桌面内核缺席，jsQR 全平台行为一致。
 * 组件只管相机生命周期与解码，结果语义（解析/填表/报错提示）由父组件处理。
 *
 * 生命周期要点（跨 await 竞态统一用会话令牌把门）：
 * - getUserMedia/await 期间弹窗被关/组件被卸载 → stream 落地时令牌已失效，立即回收；
 * - open() 重入守卫：弹窗开着时重复触发不再叠加采集会话（双循环/双 emit 的根源）；
 * - 任何关闭途径（取消/Esc/backdrop/命中收帧/退后台）都停相机并移除全局监听。
 */
const { t } = useI18n()
const emit = defineEmits<{ decoded: [text: string] }>()

const dialogEl = ref<HTMLDialogElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const cameraError = ref('')

let session = 0
let stream: MediaStream | null = null
let rafId = 0
let lastScanAt = 0
let canvas: HTMLCanvasElement | null = null
let ctx: CanvasRenderingContext2D | null = null

const stopCamera = () => {
    // 令牌自增：所有挂起中的 startCamera 续体（getUserMedia/play 之后）落地即失效
    session++
    if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
    }
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    if (videoEl.value) videoEl.value.srcObject = null
}

const releaseStream = () => {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    if (videoEl.value) videoEl.value.srcObject = null
}

/** 视频轨道中途死亡（权限被回收/被其他应用抢占）：停循环并给出可见提示，不留冻结帧 */
const onTrackEnded = () => {
    cameraError.value = t('gateway.scanCameraError')
    stopCamera()
}

/** 逐帧解码循环：节流到 ~7fps + 帧缩到 640 宽，压住低端机的 CPU/GC 压力 */
const scanFrame = () => {
    const video = videoEl.value
    // 流已被清（弹窗已关/已停）：终止循环，绝不空转续命
    if (!video || !video.srcObject) return
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
        rafId = requestAnimationFrame(scanFrame)
        return
    }
    const now = performance.now()
    if (now - lastScanAt < 150) {
        rafId = requestAnimationFrame(scanFrame)
        return
    }
    lastScanAt = now
    const w = video.videoWidth
    const h = video.videoHeight
    if (!ctx) {
        canvas = document.createElement('canvas')
        ctx = canvas?.getContext('2d', { willReadFrequently: true }) ?? null
        // 拿不到 2D 上下文（内存吃紧/Canvas 被禁）：静默 return 会让相机常亮而永远解不出码
        if (!ctx) {
            cameraError.value = t('gateway.scanCameraError')
            stopCamera()
            return
        }
    }
    const scale = Math.min(1, 640 / w)
    const dw = Math.round(w * scale)
    const dh = Math.round(h * scale)
    // 同值赋 canvas.width/height 也会重置位图：分辨率没变就跳过
    if (canvas!.width !== dw || canvas!.height !== dh) {
        canvas!.width = dw
        canvas!.height = dh
    }
    ctx.drawImage(video, 0, 0, dw, dh)
    const image = ctx.getImageData(0, 0, dw, dh)
    const code = jsQR(image.data, dw, dh, { inversionAttempts: 'dontInvert' })
    if (code?.data) {
        // 命中即收：先停相机再关弹窗，emit 放最后（父组件处理时相机已释放）
        stopCamera()
        dialogEl.value?.close()
        emit('decoded', code.data)
        return
    }
    rafId = requestAnimationFrame(scanFrame)
}

const startCamera = async () => {
    cameraError.value = ''
    const my = ++session
    try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported')
        // 后置摄像头优先（扫码场景），桌面退化到默认摄像头
        const media = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' },
            audio: false,
        })
        // await 期间被关/重开/卸载：落地即回收，绝不占着摄像头
        if (my !== session) {
            media.getTracks().forEach((track) => track.stop())
            return
        }
        stream = media
        const video = videoEl.value
        if (!video) {
            releaseStream()
            return
        }
        stream.getVideoTracks()[0]?.addEventListener('ended', onTrackEnded)
        video.srcObject = stream
        await video.play()
        if (my !== session) return
        rafId = requestAnimationFrame(scanFrame)
    } catch {
        // 迟到的失败续体（旧会话的 getUserMedia 此刻才 reject）：与当前会话无关，
        // 绝不能回收当前会话正在跑的流——那会把正在用的相机直接杀掉
        if (my !== session) return
        console.warn('[qr-scanner] startCamera failed (permission denied / no camera / play rejected)')
        // 用 stopCamera 而非 releaseStream：顺带清 rAF 与令牌，旧循环不续命
        stopCamera()
        cameraError.value = t('gateway.scanCameraError')
    }
}

/** 退后台必须停相机（rAF 会自动暂停，但 MediaStream track 不会）；回前台且弹窗仍开着则重启 */
const onVisibilityChange = () => {
    if (document.hidden) {
        stopCamera()
    } else if (dialogEl.value?.open) {
        void startCamera()
    }
}

/** 可聚焦元素（焦点环候选） */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/** 嵌套 showModal 只置 inert 弹窗外文档：先开的网关弹窗仍在 top layer，Tab 会逃逸过去，需手动钳制焦点圈 */
const trapFocus = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialogEl.value) return
    // backdrop 里的「close」按钮（form method=dialog）不可见：留在焦点环里等于把焦点停到
    // 隐形元素上（视觉上像焦点消失），按 closest('.modal-backdrop') 整体剔除
    const focusables = Array.from(dialogEl.value.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => !el.closest('.modal-backdrop'))
    if (!focusables.length) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    const inside = dialogEl.value.contains(active)
    if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault()
        last.focus()
    } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault()
        first.focus()
    }
}

const open = () => {
    if (dialogEl.value?.open) return
    cameraError.value = ''
    try {
        dialogEl.value?.showModal()
    } catch (e) {
        // detached / 非 dialog / 已在 top layer 等异常：不开采集，也不残留全局监听
        console.warn('[qr-scanner] showModal failed:', e)
        return
    }
    // 焦点圈必须挂在 document 的捕获阶段：嵌套 showModal 后焦点逃到先开的网关弹窗时，
    // 按键事件根本不经过本 dialog（模板级 @keydown 是死代码），只有捕获阶段才拦得到
    document.addEventListener('keydown', trapFocus, true)
    // 退后台跟显隐：注册放在 showModal 成功之后，开窗失败就不留全局监听
    document.addEventListener('visibilitychange', onVisibilityChange)
    void startCamera()
}

// 原生 dialog 任意途径关闭（取消/Esc/backdrop）都停相机并摘除全局监听
const onDialogClose = () => {
    stopCamera()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    document.removeEventListener('keydown', trapFocus, true)
}

onBeforeUnmount(() => {
    stopCamera()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    document.removeEventListener('keydown', trapFocus, true)
})

defineExpose({ open })
</script>

<template>
    <dialog ref="dialogEl" class="modal" @close="onDialogClose">
        <div class="modal-box">
            <h3 class="font-bold text-lg mb-2">{{ $t('gateway.scanTitle') }}</h3>
            <p class="text-xs text-base-content/60 mb-3">{{ $t('gateway.scanHint') }}</p>
            <div class="relative mx-auto aspect-square w-full max-w-xs overflow-hidden rounded-xl bg-black">
                <video ref="videoEl" class="h-full w-full object-cover" playsinline muted></video>
                <!-- 相机不可用/权限被拒：全屏提示盖在预览区上，弹窗可正常关闭 -->
                <div v-if="cameraError"
                    class="absolute inset-0 flex items-center justify-center bg-base-200 p-6 text-center text-sm text-base-content/80">
                    <div class="space-y-2">
                        <CameraIcon class="mx-auto h-8 w-8 text-base-content/40" />
                        <p>{{ cameraError }}</p>
                    </div>
                </div>
            </div>
            <div class="modal-action">
                <form method="dialog">
                    <button class="btn">{{ $t('common.cancel') }}</button>
                </form>
            </div>
        </div>
        <form method="dialog" class="modal-backdrop">
            <button>close</button>
        </form>
    </dialog>
</template>

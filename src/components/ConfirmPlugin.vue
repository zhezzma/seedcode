<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useConfirm } from '../composables/useConfirm'

const confirmState = useConfirm()
const { cancel, ok } = confirmState

/**
 * 用原生 showModal() 进 top layer 显示：宿主可能是同样由 showModal() 打开的
 * 弹窗（设置页网关管理、智能体表单等），top layer 内 z-index 无效（CSS
 * modal-open + z-[9999] 压不住），只有同样进 top layer 且后进者置顶才能盖上。
 */
const dialogEl = ref<HTMLDialogElement | null>(null)
watch(() => confirmState.show, (show) => {
    if (show) {
        if (dialogEl.value?.open) return
        try {
            dialogEl.value?.showModal()
        } catch {
            // detached 等异常开不出窗：按取消结清，不留悬挂 promise、不残留监听
            cancel()
            return
        }
        document.addEventListener('keydown', trapFocus, true)
    } else if (dialogEl.value?.open) {
        dialogEl.value.close()
    }
})

/** 可聚焦元素（焦点环候选）；确认弹窗只含按钮，无需 QrScannerModal 的全量选择器 */
const trapFocus = (event: KeyboardEvent) => {
    if (event.key !== 'Tab' || !dialogEl.value) return
    const focusables = Array.from(
        dialogEl.value.querySelectorAll<HTMLElement>('button:not([disabled])'),
    ).filter((el) => !el.closest('.modal-backdrop'))
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

// 原生关闭途径（Esc、watch 里的程序化 close、backdrop 表单提交）统一收敛到
// close 事件：未决 promise（Esc 取消）按取消结清；ok/cancel 路径已先 resolve，
// 此处为空操作。close 事件是排队的 task——关窗后同轮重入 confirm 会先重开
// dialog，陈旧事件落地时 open 已为 true，须跳过以免把新确认按取消结清
const onClose = () => {
    if (dialogEl.value?.open) return
    document.removeEventListener('keydown', trapFocus, true)
    cancel()
}

onBeforeUnmount(() => {
    document.removeEventListener('keydown', trapFocus, true)
})
</script>

<template>
    <Teleport to="body">
        <dialog ref="dialogEl" class="modal" @close="onClose">
            <div class="modal-box">
                <h3 class="font-bold text-lg">{{ confirmState.title }}</h3>
                <p class="py-4 whitespace-pre-wrap">{{ confirmState.message }}</p>
                <div class="modal-action">
                    <button class="btn" @click="cancel">{{ $t('common.cancel') }}</button>
                    <button class="btn btn-primary" @click="ok">{{ $t('common.ok') }}</button>
                </div>
            </div>
            <!-- form method=dialog：原生关闭走 close 事件统一结清；按钮不进焦点环 -->
            <form method="dialog" class="modal-backdrop">
                <button class="sr-only">{{ $t('common.close') }}</button>
            </form>
        </dialog>
    </Teleport>
</template>

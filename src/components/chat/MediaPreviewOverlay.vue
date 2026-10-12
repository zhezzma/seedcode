<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMediaPreview } from '../../composables/useMediaPreview'

const { t } = useI18n()

const {
    lightboxOpen,
    lightboxSrc,
    imgScale,
    imgTranslateX,
    imgTranslateY,
    isDragging,
    isMouseDragging,
    canNavigateLightbox,
    showPreviousImage,
    showNextImage,
    handleLightboxKeydown,
    closeLightbox,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleWheel,
    handleImageDblClick,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    downloadImage,
    copyImageToClipboard,
    canShareImage,
    isMobileDevice,
    lightboxImageName,
    shareImage,
    fileViewerOpen,
    fileViewerName,
    fileViewerContent,
    closeFileViewer,
} = useMediaPreview()

onMounted(() => {
    window.addEventListener('keydown', handleLightboxKeydown)
})

onBeforeUnmount(() => {
    window.removeEventListener('keydown', handleLightboxKeydown)
})
</script>

<template>
    <!-- Image Lightbox Modal -->
    <Teleport to="body">
        <Transition name="fade">
            <div v-if="lightboxOpen" @click.self="closeLightbox"
                class="fixed inset-0 z-50 bg-black/95 backdrop-blur-md overflow-hidden flex items-center justify-center touch-none"
                @mousemove="handleMouseMove" @mouseup="handleMouseUp" @mouseleave="handleMouseUp">

                <div class="relative w-full h-full flex items-center justify-center p-2 sm:p-4"
                    @click.self="closeLightbox">
                    <img :src="lightboxSrc" @touchstart="handleTouchStart" @touchmove.prevent="handleTouchMove"
                        @touchend="handleTouchEnd" @touchcancel="handleTouchEnd" @mousedown="handleMouseDown"
                        @wheel="handleWheel" @dblclick="handleImageDblClick" @click.stop :style="{
                            transform: `translate(${imgTranslateX}px, ${imgTranslateY}px) scale(${imgScale})`,
                            transition: isDragging || isMouseDragging ? 'none' : 'transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)'
                        }" class="max-w-[100vw] max-h-[100vh] object-contain shadow-2xl select-none"
                        :class="imgScale > 1 ? 'cursor-move' : ''" draggable="false" />
                </div>

                <!-- Previous image -->
                <button v-if="canNavigateLightbox" @click.stop="showPreviousImage"
                    class="fixed left-3 sm:left-6 top-1/2 -translate-y-1/2 btn btn-ghost btn-circle bg-white/10 text-white hover:bg-white/20 backdrop-blur-md z-[60]"
                    :title="t('chat.previousImage')" :aria-label="t('chat.previousImage')">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                        stroke="currentColor" class="w-7 h-7">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                    </svg>
                </button>

                <!-- Next image -->
                <button v-if="canNavigateLightbox" @click.stop="showNextImage"
                    class="fixed right-3 sm:right-6 top-1/2 -translate-y-1/2 btn btn-ghost btn-circle bg-white/10 text-white hover:bg-white/20 backdrop-blur-md z-[60]"
                    :title="t('chat.nextImage')" :aria-label="t('chat.nextImage')">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                        stroke="currentColor" class="w-7 h-7">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                </button>

                <!-- Tools -->
                <div class="fixed top-4 right-4 flex items-center gap-2 z-[60]">
                    <!-- Share -->
                    <button v-if="canShareImage" @click.stop="shareImage(lightboxSrc)"
                        class="btn btn-ghost btn-circle bg-white/10 text-white hover:bg-white/20 backdrop-blur-md"
                        :title="t('chat.shareImage')">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                            stroke="currentColor" class="w-6 h-6">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                d="M7.217 10.907a2.25 2.25 0 100 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186l9.566-5.314m-9.566 7.5l9.566 5.314m0 0a2.25 2.25 0 103.935 2.186 2.25 2.25 0 00-3.935-2.186zm0-12.814a2.25 2.25 0 103.933-2.185 2.25 2.25 0 00-3.933 2.185z" />
                        </svg>
                    </button>
                    <!-- Copy -->
                    <button v-if="!isMobileDevice" @click.stop="copyImageToClipboard(lightboxSrc)"
                        class="btn btn-ghost btn-circle bg-white/10 text-white hover:bg-white/20 backdrop-blur-md"
                        :title="t('chat.copyImage')">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                            stroke="currentColor" class="w-6 h-6">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                        </svg>
                    </button>
                    <!-- Download -->
                    <button @click.stop="downloadImage(lightboxSrc)"
                        class="btn btn-ghost btn-circle bg-white/10 text-white hover:bg-white/20 backdrop-blur-md"
                        :title="t('chat.downloadImage')">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                            stroke="currentColor" class="w-6 h-6">
                            <path stroke-linecap="round" stroke-linejoin="round"
                                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                        </svg>
                    </button>
                    <!-- Close -->
                    <button @click.stop="closeLightbox"
                        class="btn btn-ghost btn-circle bg-white/10 text-white hover:bg-white/20 backdrop-blur-md"
                        :title="t('common.close')">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                            stroke="currentColor" class="w-6 h-6">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                <!-- Name & zoom hint at bottom -->
                <div
                    class="fixed bottom-6 left-1/2 -translate-x-1/2 bg-black/60 text-white/90 px-4 py-1.5 rounded-full text-xs backdrop-blur-md pointer-events-none z-[60] flex items-center gap-2 max-w-[90vw]">
                    <span class="truncate">{{ lightboxImageName }}</span>
                    <span v-if="imgScale === 1" class="shrink-0 opacity-60">{{ t('chat.zoomHint') }}</span>
                </div>
            </div>
        </Transition>
    </Teleport>

    <!-- File Content Viewer Modal -->
    <Teleport to="body">
        <Transition name="fade">
            <div v-if="fileViewerOpen" @click="closeFileViewer"
                class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
                <div @click.stop
                    class="bg-base-100 rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden border border-base-300">
                    <!-- Header -->
                    <div class="flex items-center justify-between px-4 py-3 border-b border-base-300 bg-base-200">
                        <div class="flex items-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                                stroke="currentColor" class="w-5 h-5 opacity-60">
                                <path stroke-linecap="round" stroke-linejoin="round"
                                    d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                            </svg>
                            <span class="font-medium text-sm truncate max-w-[300px]" :title="fileViewerName">{{
                                fileViewerName }}</span>
                        </div>
                        <button @click="closeFileViewer" class="btn btn-ghost btn-sm btn-circle">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2"
                                stroke="currentColor" class="w-5 h-5">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <!-- Content -->
                    <div class="flex-1 overflow-auto p-4 bg-base-300/30">
                        <pre
                            class="text-sm whitespace-pre-wrap break-words font-mono bg-base-100 rounded-lg p-4 border border-base-300">
                        <code>{{ fileViewerContent }}</code>
                    </pre>
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
    transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
    opacity: 0;
}
</style>

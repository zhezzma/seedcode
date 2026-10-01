<script setup lang="ts">
/**
 * AgentAvatar - Displays agent avatar with fallback chain:
 * 1. avatar (base64 or URL image)
 * 2. Default emoji 🤖
 */
withDefaults(defineProps<{
    avatar?: string
    name?: string
    size?: 'xs' | 'sm' | 'md' | 'lg'
}>(), {
    size: 'md'
})

const sizeClasses: Record<string, string> = {
    xs: 'w-6 h-6',
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-14 h-14',
}

const emojiSizeClasses: Record<string, string> = {
    xs: 'text-sm',
    sm: 'text-lg',
    md: 'text-xl',
    lg: 'text-3xl',
}

</script>

<template>
    <div class="rounded-full bg-base-200/50 flex items-center justify-center overflow-hidden select-none shrink-0"
        :class="sizeClasses[size]">
        <!-- 1. Avatar image (base64 or URL) -->
        <img v-if="avatar" :src="avatar" :alt="name || 'Agent'" class="w-full h-full object-cover" />
        <!-- 2. Emoji fallback (default 🤖) -->
        <span v-else :class="emojiSizeClasses[size]">🤖</span>
    </div>
</template>

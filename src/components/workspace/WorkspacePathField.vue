<script setup lang="ts">
/**
 * 工作区路径输入 + 服务端校验字段（spec §5.1）。
 * - 校验管线来自 useWorkspaceBinding（防抖 + GET /api/workspace/resolve），
 *   状态行展示 校验中/成功(git・.seedcode 标记)/失败(错误码→i18n)。
 * - 仅 Tauri 壳内且网关指向本机（回环/*.localhost）时显示原生文件夹选择器
 *   （plugin-dialog，选完回填即走同一校验管线）；Web 构建/远程网关一律手输。
 * 注：binding 是含 refs 的普通对象，模板对其属性不自动解包，需 binding.x.value。
 */
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CheckCircleIcon, XCircleIcon, FolderIcon } from "@heroicons/vue/24/outline";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUiSettingsStore } from "../../stores/setting";
import { isTauri } from "../../composables/notify-server-connection";
import { isLocalGateway } from "../../utils/gateway-url";
import { errorToI18nKey } from "../../utils/workspace-binding";
import { useWorkspaceBinding, type WorkspaceResolvePayload } from "../../composables/useWorkspaceBinding";

const props = defineProps<{ modelValue: string; agentId?: string }>();
const emit = defineEmits<{
    (e: "update:modelValue", v: string): void;
    (e: "validated", payload: { basename: string; result: WorkspaceResolvePayload | null }): void;
}>();

const { t } = useI18n();
const settingsStore = useUiSettingsStore();
const binding = useWorkspaceBinding({ agentId: () => props.agentId });

// 本地网关（回环地址）+ Tauri 壳内才提供原生选择器；Web/远程一律手输
const canBrowse = computed(() => isTauri && isLocalGateway(settingsStore.apiBaseUrl));

const onBrowse = async () => {
    try {
        const picked = await openDialog({ directory: true, multiple: false });
        if (typeof picked === "string") emit("update:modelValue", picked);
    } catch { /* 用户取消/插件异常：静默，保持手输可用 */ }
};

watch(() => props.modelValue, (v) => binding.setPath(v), { immediate: true });
watch(() => [binding.basename.value, binding.result.value] as const, ([basename, result]) => {
    emit("validated", { basename, result });
});

const onInput = (e: Event) => emit("update:modelValue", (e.target as HTMLInputElement).value);

defineExpose({ revalidate: binding.revalidate });
</script>

<template>
    <div class="flex flex-col gap-1.5">
        <label class="text-xs font-medium text-base-content/70">{{ t('workspaceBinding.fieldLabel') }}</label>
        <div class="flex items-center gap-2 input input-bordered input-sm w-full font-mono">
            <FolderIcon class="w-4 h-4 shrink-0 opacity-50" />
            <input type="text" class="grow bg-transparent outline-none" :value="modelValue"
                :placeholder="t('workspaceBinding.placeholder')" @input="onInput" />
            <button v-if="canBrowse" class="btn btn-ghost btn-xs shrink-0" @click="onBrowse">
                {{ t('workspaceBinding.browse') }}
            </button>
            <span v-if="binding.checking.value" class="loading loading-spinner loading-xs"></span>
        </div>

        <!-- 状态行：校验结果 + 已绑定提示合并为一行（· 分隔），窄屏自动换行 -->
        <div v-if="binding.error.value" class="flex items-center gap-1.5 text-error text-xs">
            <XCircleIcon class="w-4 h-4 shrink-0" />
            <span>{{ t(errorToI18nKey(binding.error.value)!) }}</span>
        </div>
        <div v-else-if="binding.result.value" class="flex items-center flex-wrap gap-x-2 gap-y-0.5 text-xs min-w-0">
            <span class="flex items-center gap-1.5 text-success">
                <CheckCircleIcon class="w-4 h-4 shrink-0" />
                <span>{{ binding.result.value.resolved.isGit ? t('workspaceBinding.okGit') : t('workspaceBinding.okPlain') }}</span>
                <span v-if="binding.result.value.seedcode.hasSkills || binding.result.value.seedcode.hasExtensions
                    || binding.result.value.seedcode.hasPrompts || binding.result.value.seedcode.hasTools"
                    class="badge badge-ghost badge-xs font-mono">.seedcode</span>
            </span>
            <template v-if="binding.boundAgents.value.length === 1">
                <span class="opacity-40">·</span>
                <span class="text-info min-w-0 truncate">{{ t('workspaceBinding.boundSingle', { name: binding.boundAgents.value[0].name }) }}</span>
            </template>
            <template v-else-if="binding.boundAgents.value.length > 1">
                <span class="opacity-40">·</span>
                <span class="text-info min-w-0 truncate">{{ t('workspaceBinding.boundMultiple') }}
                    <span class="font-medium">{{ binding.boundAgents.value.map(a => a.name).join('、') }}</span></span>
            </template>
        </div>
    </div>
</template>

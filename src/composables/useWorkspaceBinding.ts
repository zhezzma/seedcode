import { computed, ref, watch } from "vue";
import type { ComputedRef, Ref } from "vue";
import { apiGet } from "./api-client";

export interface WorkspaceResolvePayload {
    resolved: { path: string; basename: string; isGit: boolean };
    pi: {
        hasSettings: boolean; hasSkills: boolean; hasExtensions: boolean;
        hasPrompts: boolean; hasSystemMd: boolean;
    };
    boundAgents: Array<{ id: string; name: string }>;
    warnings: string[];
}

export type WorkspacePathError = "not_exists" | "not_dir" | "forbidden_data_dir" | "invalid" | "network";

const ERROR_CODES: WorkspacePathError[] = ["not_exists", "not_dir", "forbidden_data_dir", "invalid"];

/**
 * 工作区绑定校验状态机（spec §5.1）。
 * 文件夹在远程服务器上：输入的是服务器路径，校验完全依赖
 * GET /api/workspace/resolve；防抖串行化请求，仅最新输入的结果生效。
 *
 * apiGet 语义（api-client.ts）：成功时已自动解包 envelope、resolve payload 本体；
 * HTTP !ok / body.ok===false / 网络拒绝均 throw（ApiError.message 携带服务端 error 串）。
 * 校验失败属防抖字段级反馈，统一传 silent=true 避免全局 toast。
 */
export function useWorkspaceBinding(options?: {
    agentId?: () => string | undefined;
    debounceMs?: number;
}) {
    const debounceMs = options?.debounceMs ?? 500;
    const path = ref("");
    const checking = ref(false);
    const result = ref<WorkspaceResolvePayload | null>(null);
    const error = ref<WorkspacePathError | null>(null);

    const basename = computed(() => result.value?.resolved.basename ?? "");
    const boundAgents = computed(() => result.value?.boundAgents ?? []);

    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function validate(value: string): Promise<void> {
        const mine = ++seq;
        checking.value = true;
        try {
            const agentId = options?.agentId?.();
            const qs = `path=${encodeURIComponent(value)}${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ""}`;
            const res = await apiGet<WorkspaceResolvePayload>(`/api/workspace/resolve?${qs}`, true);
            if (mine !== seq) return; // 过期响应丢弃
            result.value = res; // apiGet 已解包，res 即 payload
            error.value = null;
        } catch (e) {
            if (mine === seq) {
                const msg = e instanceof Error ? e.message : String(e);
                error.value = ERROR_CODES.find((c) => msg.includes(`[${c}]`)) ?? "network";
                result.value = null;
            }
        } finally {
            if (mine === seq) checking.value = false;
        }
    }

    function setPath(v: string): void {
        seq++; // 无条件作废在途请求：非空重入同样作废（模态复用窗口期，旧路径的迟到响应不得穿透 seq 检查）
        path.value = v;
        if (timer) clearTimeout(timer);
        if (!v.trim()) {
            checking.value = false;
            result.value = null;
            error.value = null;
            return;
        }
        checking.value = true; // 非空输入进入防抖即置「校验中」，直到该次校验落定才复位
        // 排程新校验即同步清旧结果：防抖+RTT 窗口内旧路径的 result 不得继续门控
        // canNext/「更新绑定」/「创建并开始」（revalidate 不经此处，保留旧结果防信任块闪烁）
        result.value = null;
        error.value = null;
        timer = setTimeout(() => { void validate(v.trim()); }, debounceMs);
    }

    async function revalidate(): Promise<void> {
        if (path.value.trim()) await validate(path.value.trim());
    }

    return { path, checking, result, error, basename, boundAgents, setPath, revalidate };
}

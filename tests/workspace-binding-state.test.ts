// 本文件为 vitest 风格（vi.mock/vi.waitFor），仓库未安装 vitest 依赖，
// 按交接口径运行：`npx -y vitest run tests/workspace-binding-state.test.ts`。
// 但 `node --test`（回归基线 399 绿）默认会发现 tests/*.test.ts，而 node 环境无法
// 解析 "vitest" 包（ERR_MODULE_NOT_FOUND 会让回归变红）。故此处做运行器自守卫：
// 仅在 vitest 环境下加载 vitest 并注册用例；node --test 下注册一个说明性占位用例。
const inVitest = process.env.VITEST !== undefined;

const okPayload = (over: any = {}) => ({
    resolved: { path: "/srv/proj", basename: "proj", isGit: true },
    pi: { hasSettings: false, hasSkills: false, hasExtensions: false, hasPrompts: false, hasSystemMd: false },
    boundAgents: [],
    warnings: [],
    ...over,
});

if (inVitest) {
    const { beforeEach, describe, expect, it, vi } = await import("vitest");

    const apiState = { get: vi.fn(), post: vi.fn() };

    // useWorkspaceBinding.ts 写 `import { apiGet, apiPost } from './api-client'`，
    // 从测试文件视角 mock 该模块路径。
    // apiGet/apiPost 真实合约（api-client.ts）：成功 resolve payload 本体；失败/网络 reject Error。
    // 注：守卫块内不能用会被提升、且必须位于模块顶层的 vi.mock，改用运行时注册的 vi.doMock，
    // 并在其后动态 import 被测模块，保证其依赖解析到上面的 mock。
    vi.doMock("../src/composables/api-client", () => ({
        apiGet: apiState.get,
        apiPost: apiState.post,
    }));

    const { useWorkspaceBinding } = await import("../src/composables/useWorkspaceBinding");

    describe("useWorkspaceBinding", () => {
        beforeEach(() => { vi.clearAllMocks(); });

        it("空路径不触发请求，状态为初始", async () => {
            const b = useWorkspaceBinding({ debounceMs: 0 });
            b.setPath("");
            await vi.waitFor(() => expect(apiState.get).not.toHaveBeenCalled());
            expect(b.error.value).toBeNull();
            expect(b.result.value).toBeNull();
        });

        it("合法路径：结果/基本信息就绪，basename 可用", async () => {
            apiState.get.mockResolvedValue(okPayload({ boundAgents: [{ id: "coder", name: "Coder" }] }));
            const b = useWorkspaceBinding({ debounceMs: 0 });
            b.setPath("/srv/proj");
            await vi.waitFor(() => expect(b.checking.value).toBe(false));
            expect(b.basename.value).toBe("proj");
            expect(b.boundAgents.value).toEqual([{ id: "coder", name: "Coder" }]);
            expect(b.error.value).toBeNull();
            expect(apiState.get).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent("/srv/proj")), true);
        });

        it("竞态：第二次校验发出前释放的迟到响应被 setPath 作废", async () => {
            // 两个调用均为受控 deferred：B 的响应在断言 A 已被丢弃之后才放行，时序完全确定
            const defer = () => {
                let resolve!: (v: any) => void;
                const promise = new Promise<any>((r) => { resolve = r; });
                return { promise, resolve };
            };
            const a = defer();
            const b2 = defer();
            apiState.get.mockImplementationOnce(() => a.promise);
            apiState.get.mockImplementationOnce(() => b2.promise);
            const b = useWorkspaceBinding({ debounceMs: 0 });
            b.setPath("/srv/a");
            await vi.waitFor(() => expect(apiState.get).toHaveBeenCalledTimes(1));
            // 模态复用：A 的响应仍在途时切到 B 路径（此刻 setPath 作废 A；无该作废时 seq 仍是 A 的）
            b.setPath("/srv/b");
            // 立即放行 A 的迟到响应——早于 B 的防抖定时器触发、即 validateB 尚未 ++seq
            a.resolve(okPayload({ resolved: { path: "/srv/a", basename: "a", isGit: true } }));
            for (let i = 0; i < 10; i++) await Promise.resolve(); // 仅冲刷微任务，不跨宏任务（B 的定时器不动）
            // 窗口期内陈旧响应不得落地：B 尚未发出，result 只能是 null（回归时会短暂变成 basename "a"）
            expect(apiState.get).toHaveBeenCalledTimes(1);
            expect(b.result.value).toBeNull();
            // 放行 B 的校验与响应，最终落定为 "b"
            await vi.waitFor(() => expect(apiState.get).toHaveBeenCalledTimes(2));
            b2.resolve(okPayload({ resolved: { path: "/srv/b", basename: "b", isGit: true } }));
            await vi.waitFor(() => expect(b.basename.value).toBe("b"));
            expect(b.error.value).toBeNull();
        });

        it("陈旧门控：非空重入同步清旧 result，窗口期内不门控按钮", async () => {
            apiState.get.mockResolvedValueOnce(okPayload());
            apiState.get.mockResolvedValueOnce(okPayload({ resolved: { path: "/srv/other", basename: "other", isGit: true } }));
            const b = useWorkspaceBinding({ debounceMs: 0 });
            b.setPath("/srv/proj");
            await vi.waitFor(() => expect(b.basename.value).toBe("proj"));
            b.setPath("/srv/other");
            expect(b.result.value).toBeNull(); // 同步断言：路径一变旧结果即清
            await vi.waitFor(() => expect(b.basename.value).toBe("other"));
        });

        it("失败：解析 [code] 前缀为枚举", async () => {
            apiState.get.mockRejectedValue(new Error("[not_exists] workspaceDir 校验失败: /x"));
            const b = useWorkspaceBinding({ debounceMs: 0 });
            b.setPath("/x");
            await vi.waitFor(() => expect(b.error.value).toBe("not_exists"));
            expect(b.result.value).toBeNull();
        });

        it("reject（网络）→ error=network", async () => {
            apiState.get.mockRejectedValue(new Error("offline"));
            const b = useWorkspaceBinding({ debounceMs: 0 });
            b.setPath("/srv/proj");
            await vi.waitFor(() => expect(b.error.value).toBe("network"));
        });
    });
} else {
    const { test } = await import("node:test");
    test("useWorkspaceBinding 状态机（vitest 专用用例集）", () => {
        // 占位：用例需 vitest 运行器（模块 mock），见文件头说明。
        // 运行：npx -y vitest run tests/workspace-binding-state.test.ts
    });
}

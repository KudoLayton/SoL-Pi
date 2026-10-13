/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import type { CompactOptions } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { createOnlineContextCompactExtension, POST_COMPACTION_PLAN_REMINDER, SKIPPED_COMPACTION_REMINDER } from "../src/sol-pi/extensions/online-context-compact/extension.ts";
import { restoreOnlineState } from "../src/sol-pi/extensions/online-context-compact/state.ts";
import { FakePi, FakeSessionManager, fakeContext } from "./helpers.ts";

async function scenario(error?: Error, unrelatedCompactionAfterError = false) {
	const manager = new FakeSessionManager();
	const messages = [{ role: "user" as const, content: "old ".repeat(4_000), timestamp: 1 }, fauxAssistantMessage("tail ".repeat(400))];
	for (const message of messages) manager.appendMessage(message);
	const pi = new FakePi(manager);
	createOnlineContextCompactExtension({ cacheWriteReadRatio: 12.5, keepRecentTokens: 1 })(pi.asExtensionApi());
	const abort = vi.fn();
	const compact = vi.fn((options: CompactOptions = {}) => {
		if (error) {
			options.onError?.(error);
			if (unrelatedCompactionAfterError) void pi.emit("session_compact", { fromExtension: false }, ctx);
		}
		else {
			const entry = { type: "compaction", id: "compact-test", parentId: manager.getLeafId(), timestamp: new Date().toISOString(), summary: "memo", firstKeptEntryId: manager.entries[1]!.id, tokensBefore: 195_000 };
			void pi.emit("session_compact", { compactionEntry: entry, fromExtension: false }, ctx).then(() => options.onComplete?.(entry));
		}
	});
	// Deferred hosts stay idle until every agent_settled handler returns.
	const ctx = fakeContext(manager, { abort, compact, isIdle: () => true,
		getContextUsage: () => ({ tokens: 195_000, contextWindow: 200_000, percent: 97.5 }) });
	await pi.emit("session_start", {}, ctx);
	await pi.emitContext(messages, ctx);
	async function boundary(id: string) {
		await pi.emit("before_provider_request", {}, ctx);
		const steps = [{ id, goal: "do work", status: "completed" }, { id: "remaining", goal: "remaining work", status: "pending" }];
		await pi.tool("update_plan").execute(`${id}-open`, { steps: steps.map((step) => step.id === id ? { ...step, status: "in_progress" } : step) }, undefined, undefined, ctx);
		await pi.emit("before_provider_request", {}, ctx);
		const result = await pi.tool("update_plan").execute(id, { steps }, undefined, undefined, ctx);
		await pi.emit("turn_end", { message: fauxAssistantMessage("boundary"), toolResults: [{ toolCallId: id, toolName: "update_plan", isError: false }] }, ctx);
		return result;
	}
	return { pi, manager, ctx, abort, compact, boundary };
}

describe("Online Context Compact recovery", () => {
	it.each(["session_start", "session_tree", "session_shutdown", "input"])("invalidates delayed callbacks and releases settlement on %s", async (lifecycle) => {
		const { pi, ctx, boundary, compact, manager } = await scenario();
		let pending: CompactOptions | undefined;
		compact.mockImplementation((options = {}) => { pending = options; });
		await boundary("first");
		const settled = pi.emit("agent_settled", {}, ctx);
		await Promise.resolve();
		expect(pending).toBeDefined();
		await pi.emit(lifecycle, lifecycle === "input" ? { text: "new request", streamingBehavior: "steer" } : {}, ctx);
		await settled;
		const before = manager.entries.length;
		const entry = { type: "compaction" as const, id: "stale", parentId: null, timestamp: new Date().toISOString(), summary: "stale", firstKeptEntryId: "stale", tokensBefore: 100 };
		pending!.onComplete?.(entry);
		pending!.onError?.(new Error("late failure"));
		expect(pi.sentMessages).toHaveLength(0);
		expect(manager.entries).toHaveLength(before);
	});

	it("does not compact a stale selected boundary after superseding input", async () => {
		const { pi, ctx, boundary, compact } = await scenario();
		await boundary("first");
		await pi.emit("input", { text: "different request", streamingBehavior: "followUp" }, ctx);
		await pi.emit("agent_settled", {}, ctx);
		expect(compact).not.toHaveBeenCalled(); expect(pi.sentMessages).toHaveLength(0);
	});

	it("releases settlement on cancellation without waiting for a late callback", async () => {
		const { pi, ctx, boundary, compact } = await scenario();
		const controller = new AbortController(); Object.assign(ctx, { signal: controller.signal });
		let pending: CompactOptions | undefined;
		compact.mockImplementation((options = {}) => { pending = options; });
		await boundary("first"); const settled = pi.emit("agent_settled", {}, ctx);
		await Promise.resolve(); controller.abort(); await settled;
		pending?.onError?.(new Error("Compaction cancelled"));
		expect(pi.sentMessages).toHaveLength(0);
	});

	it("ignores duplicate completion and concurrent settlement", async () => {
		const { pi, ctx, boundary, compact } = await scenario();
		let pending: CompactOptions | undefined;
		compact.mockImplementation((options = {}) => { pending = options; });
		await boundary("first"); const settled = pi.emit("agent_settled", {}, ctx);
		await Promise.resolve(); await pi.emit("agent_settled", {}, ctx);
		expect(compact).toHaveBeenCalledOnce();
		const entry = { type: "compaction" as const, id: "done", parentId: null, timestamp: new Date().toISOString(), summary: "memo", firstKeptEntryId: "entry", tokensBefore: 100 };
		pending!.onComplete?.(entry); pending!.onComplete?.(entry); pending!.onError?.(new Error("duplicate"));
		await settled;
		expect(pi.sentMessages).toHaveLength(1);
	});

	it("returns to deferred hosts after sending the continuation instead of throwing or deadlocking", async () => {
		const { pi, manager, ctx, boundary, compact } = await scenario();
		await boundary("first");
		await expect(pi.emit("agent_settled", {}, ctx)).resolves.toBeUndefined();
		expect(compact).toHaveBeenCalledOnce();
		expect(pi.sentMessages).toHaveLength(1);
		expect(pi.sentMessages[0]?.message.content).toBe(POST_COMPACTION_PLAN_REMINDER);
		expect(restoreOnlineState(manager.entries).nativeCompactionCount).toBe(1);
	});

	it.each([
		"Nothing to compact (session too small)",
		"Already compacted",
		"Summarization failed: generation hit the token cap and the summary is incomplete",
	])("continues after %s and blocks repeated plan-only attempts", async (message) => {
		const { pi, manager, ctx, boundary, compact, abort } = await scenario(new Error(message));
		await boundary("first");
		await expect(pi.emit("agent_settled", {}, ctx)).resolves.toBeUndefined();
		expect(pi.sentMessages[0]?.message.content).toBe(SKIPPED_COMPACTION_REMINDER);
		expect(manager.entries).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "custom", customType: "sol-pi-online-context-compact-skipped", data: { reason: message } }),
		]));
		expect(restoreOnlineState(manager.entries)).toMatchObject({ nativeCompactionCount: 0, cacheDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
		for (const id of ["restated", "rekeyed-again", "rekeyed-once-more"]) {
			await boundary(id);
			await pi.emit("agent_settled", {}, ctx);
		}
		expect(abort).toHaveBeenCalledOnce();
		expect(compact).toHaveBeenCalledOnce();
		expect(pi.sentMessages).toHaveLength(1);
		await pi.emit("turn_end", { message: fauxAssistantMessage("new work"), toolResults: [{ toolName: "bash", isError: false }] }, ctx);
		await boundary("genuine-progress");
		await pi.emit("agent_settled", {}, ctx);
		expect(compact).toHaveBeenCalledTimes(2);
	});

	it.each([new Error("Compaction cancelled"), Object.assign(new Error("cancelled"), { name: "AbortError" })])("does not resume cancelled work: $name / $message", async (error) => {
		const { pi, ctx, boundary } = await scenario(error);
		await boundary("first");
		await expect(pi.emit("agent_settled", {}, ctx)).resolves.toBeUndefined();
		expect(pi.sentMessages).toHaveLength(0);
	});

	it.each([true, false])("uses the owned compaction signal for wrapped errors (aborted=%s)", async (aborted) => {
		const { pi, ctx, boundary, compact } = await scenario();
		const controller = new AbortController();
		const error = new Error("Turn prefix summarization failed: This operation was aborted");
		compact.mockImplementation((options = {}) => {
			void pi.emit("session_before_compact", { customInstructions: options.customInstructions, signal: controller.signal }, ctx).then(() => {
				if (aborted) controller.abort();
				options.onError?.(error);
			});
		});
		await boundary("first");
		const settled = pi.emit("agent_settled", {}, ctx);
		if (aborted) await expect(settled).resolves.toBeUndefined();
		else await expect(settled).rejects.toBe(error);
		expect(pi.sentMessages).toHaveLength(0);
	});

	it("does not adopt an unrelated compaction's aborted signal", async () => {
		const { pi, ctx, boundary, compact } = await scenario();
		const error = new Error("summarizer unavailable");
		compact.mockImplementation((options = {}) => {
			void pi.emit("session_before_compact", { customInstructions: "manual summary", signal: AbortSignal.abort() }, ctx).then(() => options.onError?.(error));
		});
		await boundary("first");
		await expect(pi.emit("agent_settled", {}, ctx)).rejects.toBe(error);
		expect(pi.sentMessages).toHaveLength(0);
	});

	it("still reports genuine compaction failures", async () => {
		const { pi, ctx, boundary } = await scenario(new Error("summarizer unavailable"));
		await boundary("first");
		await expect(pi.emit("agent_settled", {}, ctx)).rejects.toThrow("summarizer unavailable");
		expect(pi.sentMessages).toHaveLength(0);
	});

	it("does not charge a failed attempt's debt to another compaction during recovery", async () => {
		const { pi, ctx, manager, boundary } = await scenario(new Error("Already compacted"), true);
		await boundary("first");
		await pi.emit("agent_settled", {}, ctx);
		expect(restoreOnlineState(manager.entries)).toMatchObject({ nativeCompactionCount: 1, cacheDebtTokens: 0, cacheDebtRepaymentTokens: 0 });
	});
});

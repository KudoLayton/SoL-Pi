/* SPDX-License-Identifier: MIT */
import { expect, it, vi } from "vitest";
import { createLiveBudget, LIVE_PHASES } from "../scripts/live-budget.ts";
const url = "https://example.invalid/v1/responses";
const valid = () => ({ method: "POST", body: JSON.stringify({ model: "fixture", input: [], max_output_tokens: 2048 }) });
it("never sends unarmed, wrong-model, oversized or unbounded requests", async () => {
	const transport = vi.fn(async () => new Response("ok")); const gate = createLiveBudget("fixture", transport);
	await expect(gate.fetch(url, valid())).rejects.toThrow("UNARMED_NETWORK");
	gate.setEndpoint("https://example.invalid/v1"); gate.arm("epr-fused");
	for (const payload of [{ model: "other", max_output_tokens: 2048 }, { model: "fixture" }, { model: "fixture", max_output_tokens: 2049 }, { model: "fixture", max_output_tokens: 2048, input: "x".repeat(65536) }]) {
		await expect(gate.fetch(url, { method: "POST", body: JSON.stringify(payload) })).rejects.toThrow();
	}
	await expect(gate.fetch(`${url}/compact`, valid())).rejects.toThrow("ENDPOINT_DENIED");
	await expect(gate.fetch("https://auth.invalid/token", valid())).rejects.toThrow("ENDPOINT_DENIED");
	expect(transport).not.toHaveBeenCalled();
});
it("counts failed attempts and forbids retries, redirects and a fifth request", async () => {
	const transport = vi.fn(async () => new Response("failed", { status: 500 })); const gate = createLiveBudget("fixture", transport);
	gate.setEndpoint("https://example.invalid/v1");
	for (const phase of LIVE_PHASES) { gate.arm(phase); await gate.fetch(url, valid()); await expect(gate.fetch(url, valid())).rejects.toThrow("REQUEST_BUDGET_EXHAUSTED"); }
	expect(transport).toHaveBeenCalledTimes(4); expect(gate.records).toHaveLength(4);
	expect(transport).toHaveBeenLastCalledWith(url, expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
	gate.disarm(); await expect(gate.fetch(url, valid())).rejects.toThrow("UNARMED_NETWORK");
});
it("carries request counts across a resumed local-only failure", async () => {
	const transport = vi.fn(async () => new Response("ok"));
	const gate = createLiveBudget("fixture", transport, 350_000.75, [{ phase: "epr-fused", bytes: 100, status: 200 }, { phase: "epr-independent", bytes: 100, status: 200 }]);
	gate.setEndpoint("https://example.invalid/v1"); gate.arm("epr-fused");
	await expect(gate.fetch(url, valid())).rejects.toThrow("REQUEST_BUDGET_EXHAUSTED");
	gate.arm("native-compaction"); await gate.fetch(url, valid()); gate.arm("continuation"); await gate.fetch(url, valid());
	expect(transport).toHaveBeenCalledTimes(2); expect(gate.records).toHaveLength(4);
});

it("denies expired total deadlines without sending", async () => {
	const transport = vi.fn(async () => new Response("ok")); const gate = createLiveBudget("fixture", transport, 1);
	gate.setEndpoint("https://example.invalid/v1"); gate.arm("epr-fused"); await new Promise((resolve) => setTimeout(resolve, 5));
	await expect(gate.fetch(url, valid())).rejects.toThrow("TOTAL_DEADLINE"); expect(transport).not.toHaveBeenCalled();
});

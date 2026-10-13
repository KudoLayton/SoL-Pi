/* SPDX-License-Identifier: MIT */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
const entry = join(process.cwd(), "node_modules/@narumitw/pi-codex-compact/dist/index.ts");

it.skipIf(!existsSync(entry)).each([
	["occ-first", "success"], ["codex-first", "success"],
	["occ-first", "reject"], ["codex-first", "reject"],
	["occ-first", "error"], ["codex-first", "error"],
	["occ-first", "cancel"], ["codex-first", "cancel"],
])("coexists with the unmodified codex-compact package: %s / %s", async (order, outcome) => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-coexist-"));
	const agentDir = join(cwd, "agent"); await mkdir(agentDir);
	let session: AgentSession | undefined;
	try {
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		await writeFile(join(agentDir, "pi-codex-compact.json"), JSON.stringify({ enabled: true, protocol: "responses-compact", maxRetries: 0 }));
		const occEntry = join(cwd, "occ.ts");
		await writeFile(occEntry, `import { createOnlineContextCompactExtension } from ${JSON.stringify(join(process.cwd(), "src/sol-pi/extensions/online-context-compact/extension.ts"))}; export default createOnlineContextCompactExtension({cacheWriteReadRatio:0,keepRecentTokens:150});`);
		const faux = fauxProvider({ provider: "sol-pi-offline-compact", api: "openai-responses", models: [{ id: "fixture", contextWindow: 4096, maxTokens: 1024 }] });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("update_plan", { steps: [{ id: "one", goal: "work", status: "in_progress" }] }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("update_plan", { steps: [{ id: "one", goal: "work", status: "completed" }] }), { stopReason: "toolUse" }),
			...(outcome === "reject" || outcome === "error" ? [fauxAssistantMessage("native fallback summary")] : []),
			fauxAssistantMessage("finished once"),
		]);
		let remote = 0;
		// Never contacts the network. Only the fixture compact endpoint is accepted.
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			expect(String(input)).toBe("https://example.invalid/v1/responses/compact"); remote++;
			if (outcome === "cancel") { session!.abortCompaction(); throw new DOMException("cancelled", "AbortError"); }
			if (outcome === "reject" || outcome === "error") return Response.json({ error: { message: "fixture failure" } }, { status: outcome === "reject" ? 400 : 500 });
			return Response.json({ output: [{ type: "compaction", encrypted_content: "offline-checkpoint" }], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
		});
		const provider = { ...faux.provider, stream: ((model, context, options) => {
			if (!options?.fetch) return faux.provider.stream(model, context, options);
			const stream = createAssistantMessageEventStream();
			void (async () => {
				try {
					const payload = { model: model.id, input: [{ role: "user", content: [{ type: "input_text", text: "offline synthetic history" }] }] };
					await options.onPayload?.(payload, model);
					const response = await options.fetch!("https://example.invalid/v1/responses", { method: "POST", body: JSON.stringify(payload), signal: options.signal });
					if (!response.ok) throw new Error("fixture response rejected");
					await response.text();
					stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("fixture compact complete") });
				} catch {
					stream.push({ type: "error", reason: "error", error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture remote failure" }) });
				} finally { stream.end(); }
			})();
			return stream;
		}) as typeof faux.provider.stream };
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 150, reserveTokens: 1024 }, retry: { enabled: false } });
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage({ role: "user", content: "synthetic history ".repeat(500), timestamp: 1 });
		sessionManager.appendMessage(fauxAssistantMessage("synthetic work ".repeat(500)));
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
			additionalExtensionPaths: order === "occ-first" ? [occEntry, entry] : [entry, occEntry],
			extensionFactories: [{ name: "offline-provider", factory: (pi) => pi.registerProvider(provider) }],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", tools: ["update_plan"], resourceLoader: loader, settingsManager, sessionManager }));
		await session.prompt("finish synthetic work", { expandPromptTemplates: false });
		expect(remote).toBe(1);
		const reminders = sessionManager.getBranch().filter((item) => item.type === "custom_message" && item.customType === "sol-pi-online-context-compact");
		expect(reminders).toHaveLength(outcome === "cancel" ? 0 : 1);
		expect(sessionManager.getBranch().filter((item) => item.type === "compaction")).toHaveLength(outcome === "cancel" ? 0 : 1);
		if (outcome !== "cancel") expect(session.getLastAssistantText()).toBe("finished once");
		expect(session.isIdle).toBe(true);
	} finally { session?.dispose(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(cwd, { recursive: true, force: true }); }
}, 30_000);

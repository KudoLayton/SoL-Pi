/* SPDX-License-Identifier: MIT */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { createOnlineContextCompactExtension } from "../src/sol-pi/extensions/online-context-compact/extension.ts";

it("cancels native split-turn compaction without extension errors or automatic continuation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-native-cancel-"));
	const agentDir = join(cwd, "agent"); await mkdir(agentDir);
	let session: AgentSession | undefined;
	try {
		const faux = fauxProvider({ provider: "native-cancel", api: "native-cancel-api", models: [{ id: "fixture", contextWindow: 4096, maxTokens: 1024 }] });
		let compacting = false; let requests = 0; let summaryCalls = 0;
		let compactionSignal: AbortSignal | undefined;
		let splitTurn = false;
		const errors: unknown[] = [];
		const plan = (status: string) => fauxAssistantMessage(fauxToolCall("update_plan", { steps: [{ id: "work", goal: "synthetic task ".repeat(250), status }] }), { stopReason: "toolUse" });
		faux.setResponses([plan("in_progress"), plan("completed"), ...Array.from({ length: 4 }, () => () => {
			if (!compacting) return fauxAssistantMessage("new input handled");
			summaryCalls++;
			session!.abortCompaction();
			return fauxAssistantMessage("", { stopReason: "aborted" });
		})]);
		const manager = SessionManager.inMemory(cwd);
		for (let i = 0; i < 80; i++) {
			manager.appendMessage({ role: "user", content: `old turn ${i} ` + "old data ".repeat(300), timestamp: i + 1 });
			manager.appendMessage(fauxAssistantMessage("old synthetic work ".repeat(300)));
		}
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 150, reserveTokens: 1024 }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [{ name: "native-cancel", factory: (pi) => {
				pi.registerProvider(faux.provider);
				createOnlineContextCompactExtension({ cacheWriteReadRatio: 0 })(pi);
				pi.on("session_before_compact", (event) => {
					// Observe the real native path; do not replace the compaction.
					splitTurn = event.preparation.isSplitTurn;
					requests++; compacting = true; compactionSignal = event.signal;
				});
			} }],
		});
		await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", tools: ["update_plan"], resourceLoader: loader, settingsManager, sessionManager: manager }));
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		await session.prompt("finish the synthetic task", { expandPromptTemplates: false });
		expect(errors).toEqual([]);
		expect(requests).toBe(1); expect(splitTurn).toBe(true); expect(summaryCalls).toBeGreaterThan(0);
		expect(compactionSignal?.aborted).toBe(true);
		expect(session.isIdle).toBe(true);
		expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "sol-pi-online-context-compact")).toHaveLength(0);
		expect(faux.state.callCount).toBe(2 + summaryCalls);
		compacting = false;
		await session.prompt("new synthetic request", { expandPromptTemplates: false });
		expect(session.getLastAssistantText()).toBe("new input handled");
		expect(session.isIdle).toBe(true); expect(requests).toBe(1);
		expect(errors).toEqual([]);
	} finally { session?.dispose(); await rm(cwd, { recursive: true, force: true }); }
}, 30_000);

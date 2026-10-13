/* SPDX-License-Identifier: MIT */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Pi from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { registerActionFusion } from "../src/sol-pi/extensions/action-fusion/index.ts";
import { registerObservationPack } from "../src/sol-pi/extensions/observation-pack/index.ts";
import { createEvidencePreservingReducerExtension } from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import { createOnlineContextCompactExtension } from "../src/sol-pi/extensions/online-context-compact/extension.ts";
const available = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;
const independent = Reflect.get(Pi, "createPowerShellToolDefinition") as typeof Pi.createBashToolDefinition | undefined;
for (const mode of ["fused", "independent"] as const) {
	it.skipIf(!available || (mode === "independent" && !independent))(`runs PowerShell -> EPR -> ObservationPack -> OCC (${mode})`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "sol-pi-pipeline-")); const agentDir = join(cwd, "agent"); await mkdir(agentDir);
		let session: Pi.AgentSession | undefined;
		const manager = Pi.SessionManager.inMemory(cwd);
		try {
			const order: string[] = [];
			const main = fauxProvider({ provider: "pipeline-main", api: "pipeline-main-api", models: [{ id: "main", contextWindow: 4096, maxTokens: 1024 }] });
			const reducer = fauxProvider({ provider: "pipeline-reducer", api: "pipeline-reducer-api", models: [{ id: "reducer", maxTokens: 2048 }] });
			reducer.setResponses([async (context) => {
				order.push("reducer");
				const input = JSON.stringify(context.messages);
				const hash = input.match(/source_sha256=([a-f0-9]{64})/u)![1];
				return fauxAssistantMessage(JSON.stringify({ schema: "sol-pi-evidence-receipt/1", source_sha256: hash, status: "success", uncertain: false, evidence: [{ kind: "summary", quote: "SUCCESS synthetic diagnostic" }] }));
			}]);
			const command = "function npm { 1..2500 | ForEach-Object { 'synthetic diagnostic padding line' }; 'SUCCESS synthetic diagnostic' }; npm test";
			main.setResponses([
				fauxAssistantMessage(fauxToolCall("update_plan", { steps: [{ id: "work", goal: "test", status: "in_progress" }] }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall(mode === "fused" ? "write" : "powershell", mode === "fused" ? { path: "output.txt", content: "synthetic", then_run: { command } } : { command }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("update_plan", { steps: [{ id: "work", goal: "test", status: "completed" }] }), { stopReason: "toolUse" }),
				fauxAssistantMessage("pipeline complete"),
			]);
			const settings = Pi.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 150 }, retry: { enabled: false } }, { projectTrusted: true });
			manager.appendMessage({ role: "user", content: "synthetic history ".repeat(600), timestamp: 1 }); manager.appendMessage(fauxAssistantMessage("synthetic work ".repeat(600)));
			const loader = new Pi.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: [{ name: "pipeline", factory: (pi) => {
					pi.registerProvider(main.provider); pi.registerProvider(reducer.provider);
					registerActionFusion(pi, { shell: "powershell" }); if (independent) pi.registerTool(independent(cwd));
					registerObservationPack(pi);
					createEvidencePreservingReducerExtension({ reducerProvider: reducer.getModel().provider, reducerModel: reducer.getModel().id })(pi);
					createOnlineContextCompactExtension({ cacheWriteReadRatio: 0, keepRecentTokens: 150 })(pi);
					pi.on("session_before_compact", (event) => { order.push("compact"); return { compaction: { summary: "synthetic summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }; });
				} }],
			});
			await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
			({ session } = await Pi.createAgentSession({ cwd, agentDir, model: main.getModel(), thinkingLevel: "off", resourceLoader: loader, settingsManager: settings, sessionManager: manager }));
			await session.prompt("finish synthetic pipeline", { expandPromptTemplates: false });
			expect(order).toEqual(["reducer", "compact"]);
			const tools = manager.getEntries().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
			const diagnostic = tools.find((result) => result.toolName === (mode === "fused" ? "write" : "powershell"))!;
			expect(diagnostic.isError).toBe(false);
			expect(JSON.stringify(diagnostic.content)).toContain("sol_pi_evidence_receipt_v1");
			expect(JSON.stringify(diagnostic.content)).toContain("SUCCESS synthetic diagnostic");
			expect(JSON.stringify(diagnostic.content)).not.toContain("padding line");
			expect(session.getLastAssistantText()).toBe("pipeline complete");
			expect(session.isIdle).toBe(true);
		} finally {
			session?.dispose(); await rm(cwd, { recursive: true, force: true });
			for (const name of await readdir(tmpdir())) if (name.startsWith(`sol-pi-${manager.getSessionId()}-`)) await rm(join(tmpdir(), name), { recursive: true, force: true });
		}
	}, 30_000);
}

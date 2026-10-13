/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	CONFIG_DIR_NAME,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/sol-pi/config.ts";
import { createObservation } from "../src/sol-pi/extensions/observation-pack/observation.ts";

it.skipIf(spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status !== 0).each(["persistent", "in-memory"])("runs the conservative PowerShell profile and exact recall in a %s session", async (storage) => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-native-"));
	const agentDir = join(cwd, "agent");
	let session: AgentSession | undefined;
	let ephemeralSessionId: string | undefined;
	try {
		await mkdir(agentDir);
		await mkdir(join(cwd, CONFIG_DIR_NAME));
		await writeFile(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({ ...DEFAULT_CONFIG, actionFusion: true, actionFusionShell: "powershell", observationPack: true }));
		const faux = fauxProvider({ provider: "sol-pi-native-test", api: "sol-pi-native-test-api" });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "한글.txt", content: "원문\r\n", then_run: { command: "Get-Content -LiteralPath '한글.txt'; 1..800 | ForEach-Object { 'preserved evidence line' }" } }), { stopReason: "toolUse" }),
			fauxAssistantMessage("archived"),
		]);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }, { projectTrusted: true });
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			additionalExtensionPaths: [join(process.cwd(), "src/sol-pi/index.ts")],
			extensionFactories: [{ name: "native-test-provider", factory: (pi) => pi.registerProvider(faux.provider) }],
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const sessionManager = storage === "persistent" ? SessionManager.create(cwd, join(agentDir, "sessions")) : SessionManager.inMemory(cwd);
		if (storage === "in-memory") ephemeralSessionId = sessionManager.getSessionId();
		({ session } = await createAgentSession({ cwd, agentDir, model: faux.getModel(), thinkingLevel: "off", resourceLoader, sessionManager, settingsManager }));
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["write", "edit", "obs_recall"]));
		expect(session.getActiveToolNames()).not.toContain("update_plan");
		await session.prompt("write and archive", { expandPromptTemplates: false });
		const messages = () => sessionManager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []);
		const written = messages().find((message) => message.toolName === "write")!;
		expect(written.isError, JSON.stringify(written.content)).toBe(false);
		const observation = createObservation(written, cwd)!;
		expect(observation).toBeDefined();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("obs_recall", { id: observation.id, offset: 0 }), { stopReason: "toolUse" }),
			fauxAssistantMessage("recalled"),
		]);
		await session.prompt("recall original evidence", { expandPromptTemplates: false });
		const recalled = messages().find((message) => message.toolName === "obs_recall")!;
		expect(recalled.isError).toBe(false);
		expect(recalled.content.map((block) => block.type === "text" ? block.text : "").join("\n")).toContain("preserved evidence line");
		expect(await readFile(join(cwd, "한글.txt"), "utf8")).toBe("원문\r\n");
		expect(errors).toEqual([]);
	} finally {
		session?.dispose();
		if (ephemeralSessionId) {
			const roots = (await readdir(tmpdir())).filter((name) => name.startsWith(`sol-pi-${ephemeralSessionId}-`));
			await Promise.all(roots.map((name) => rm(join(tmpdir(), name), { recursive: true, force: true })));
		}
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);


it.each(["persistent", "in-memory"])("loads the package and executes fused tools in an all-enabled %s Pi session", async (storage) => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-package-"));
	const agentDir = join(cwd, "agent");
	let session: AgentSession | undefined;
	let ephemeralSessionId: string | undefined;
	try {
		await mkdir(agentDir);
		await mkdir(join(cwd, CONFIG_DIR_NAME));
		await writeFile(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({
			...DEFAULT_CONFIG,
			actionFusion: true,
			observationPack: true,
			evidencePreservingReducer: true,
			onlineContextCompact: true,
		}));
		const faux = fauxProvider({ provider: "sol-pi-package-test", api: "sol-pi-package-test-api" });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", {
				path: "result.txt",
				content: "package integration passed\n",
				then_run: { command: "cat result.txt" },
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("update_plan", {
				steps: [{ id: "verify", goal: "verify the package", status: "in_progress" }],
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage("package smoke complete"),
		]);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}, { projectTrusted: true });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [join(process.cwd(), "src/sol-pi/index.ts")],
			extensionFactories: [{ name: "package-test-provider", factory: (pi) => pi.registerProvider(faux.provider) }],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "You are a deterministic package integration test assistant.",
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		const sessionManager = storage === "persistent"
			? SessionManager.create(cwd, join(agentDir, "sessions"))
			: SessionManager.inMemory(cwd);
		if (storage === "in-memory") ephemeralSessionId = sessionManager.getSessionId();
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			thinkingLevel: "off",
			resourceLoader,
			sessionManager,
			settingsManager,
		}));
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["edit", "write", "obs_recall", "update_plan"]));
		await session.prompt("run the package smoke test", { expandPromptTemplates: false });
		const toolResults = sessionManager.getBranch().flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
		);
		expect(toolResults).toHaveLength(2);
		expect(toolResults.every((result) => !result.isError)).toBe(true);
		const writeResult = toolResults.find((result) => result.toolName === "write");
		const observation = writeResult?.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		expect(observation).toContain("[then_run:succeeded]");
		expect(observation).toContain("package integration passed");
		expect(await readFile(join(cwd, "result.txt"), "utf8")).toBe("package integration passed\n");
		expect(session.getLastAssistantText()).toBe("package smoke complete");
		expect(session.isIdle).toBe(true);
		expect(faux.state.callCount).toBe(3);
		expect(errors).toEqual([]);
	} finally {
		session?.dispose();
		if (ephemeralSessionId) {
			const roots = (await readdir(tmpdir())).filter((name) => name.startsWith(`sol-pi-${ephemeralSessionId}-`));
			await Promise.all(roots.map((name) => rm(join(tmpdir(), name), { recursive: true, force: true })));
		}
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);

it("archives tool output with the real Pi --no-session CLI and retains it after exit", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-no-session-"));
	try {
		const agentDir = join(cwd, "agent");
		const temporaryDir = join(cwd, "tmp");
		await mkdir(agentDir);
		await mkdir(temporaryDir);
		await mkdir(join(cwd, CONFIG_DIR_NAME));
		await writeFile(join(cwd, CONFIG_DIR_NAME, "sol-pi.json"), JSON.stringify({
			...DEFAULT_CONFIG,
			actionFusion: true,
			observationPack: true,
			evidencePreservingReducer: true,
			onlineContextCompact: true,
		}));
		const body = "ephemeral CLI evidence\n".repeat(800);
		await writeFile(join(cwd, "evidence.txt"), body);
		const providerPath = join(cwd, "test-provider.ts");
		const fauxPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux"));
		await writeFile(providerPath, `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from ${JSON.stringify(fauxPath)};
export default function (pi) {
	const faux = fauxProvider({
		provider: "sol-pi-no-session-test", api: "sol-pi-no-session-test-api",
		models: [{ id: "ephemeral", contextWindow: 200000, maxTokens: 4096 }],
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("read", { path: "evidence.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("no-session smoke complete"),
	]);
	pi.registerProvider(faux.provider);
	pi.on("session_start", (_event, ctx) => {
		if (ctx.sessionManager.getSessionDir() || ctx.sessionManager.getSessionFile()) {
			throw new Error("Expected an ephemeral CLI session");
		}
	});
}
`);
		const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
		const piPackage = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
		const running = promisify(execFile)(process.execPath, [
			join(piRoot, piPackage.bin.pi), "--offline", "--approve", "--no-session",
			"--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
			"-e", join(process.cwd(), "src/sol-pi/index.ts"), "-e", providerPath,
			"--provider", "sol-pi-no-session-test", "--model", "ephemeral",
			"--thinking", "off", "-p", "read the evidence",
		], {
			cwd,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, TMPDIR: temporaryDir, TMP: temporaryDir, TEMP: temporaryDir },
			timeout: 20_000,
		});
		running.child.stdin?.end();
		const { stdout, stderr } = await running;
		expect(stdout).toContain("no-session smoke complete");
		expect(stderr).not.toMatch(/error|requires a persistent/iu);
		const roots = (await readdir(temporaryDir)).filter((name) => name.startsWith("sol-pi-"));
		expect(roots).toHaveLength(1);
		const objectsDir = join(temporaryDir, roots[0]!, "observation-pack", "objects");
		const objects = await readdir(objectsDir);
		expect(objects).toHaveLength(1);
		expect(await readFile(join(objectsDir, objects[0]!), "utf8")).toBe(body);
		expect((await readdir(agentDir, { recursive: true })).some((name) => name.endsWith(".jsonl"))).toBe(false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}, 30_000);

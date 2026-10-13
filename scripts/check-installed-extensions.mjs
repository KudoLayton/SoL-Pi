/* SPDX-License-Identifier: MIT */
// Opt-in, offline local-installation check. Run from an isolated Pi 1.2 source copy.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const script = fileURLToPath(import.meta.url);
const source = resolve(dirname(script), "..");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

if (process.argv[2] !== "--worker") {
	assert.equal(process.argv[2], "--host-agent-dir", "Explicit --host-agent-dir is required; no installation or credentials are copied");
	assert.equal(process.argv.length, 4);
	const host = resolve(process.argv[3]);
	const root = await mkdtemp(join(tmpdir(), "sol-pi-installed-check-"));
	const settings = await json(join(host, "settings.json"));
	assert.ok(Array.isArray(settings.packages));
	assert.ok(!settings.extensions?.length, "Explicit extension filters need an explicit fixture mapping");
	const tracked = ["settings.json", "sol-pi.json", "pi-auto-review.json", "pi-plan-mode.json", "pi-goal.json"];
	const snapshot = async () => Object.fromEntries(await Promise.all(tracked.map(async (file) => [file, createHash("sha256").update(await readFile(join(host, file))).digest("hex")])));
	const before = await snapshot();
	const authBefore = await stat(join(host, "auth.json")); // metadata only; never read credentials
	const packages = []; let replacements = 0;
	for (const spec of settings.packages) {
		assert.equal(typeof spec, "string", "Package filters need an explicit fixture mapping");
		let path;
		if (spec.startsWith("npm:")) {
			const name = spec.slice(4).match(/^(?:@[^/]+\/)?[^@]+/u)?.[0];
			assert.ok(name); path = join(host, "npm/node_modules", name);
		} else {
			const match = spec.match(/^git:git@github\.com:([^/]+)\/([^/]+)\.git$/u);
			assert.ok(match, "Only explicit local npm/GitHub installations are supported");
			path = join(host, "git/github.com", match[1], match[2]);
		}
		const installed = await json(join(path, "package.json"));
		const replacement = installed.name === "sol-pi" || path.endsWith("sol-pi-windows");
		if (replacement) { path = source; replacements++; }
		const manifest = replacement ? await json(join(source, "package.json")) : installed;
		assert.ok(manifest.pi?.extensions?.length, `No extension entries: ${manifest.name}`);
		packages.push({ name: manifest.name, version: manifest.version, replaced: replacement, entries: manifest.pi.extensions.map((entry) => resolve(path, entry)) });
	}
	assert.equal(replacements, 1, "Exactly one installed SoL-Pi must be replaced, never loaded alongside the checkout");
	const configs = {};
	for (const file of tracked.slice(2)) configs[file] = await json(join(host, file));
	const manifest = join(root, "manifest.json");
	await writeFile(manifest, JSON.stringify({ packages, configs }, null, 2), { mode: 0o600 });
	const cases = [];
	console.log(`Offline installed-extension report: ${join(root, "report.json")}`);
	for (const order of ["installed", "reversed", "control"]) {
		for (const mode of order === "control" ? ["fused"] : ["conservative", "fused", "independent"]) {
			for (const outcome of mode === "conservative" ? ["success"] : ["success", "cancel"]) {
				const name = `${order}-${mode}-${outcome}`;
				const cwd = join(root, name); await mkdir(cwd);
				// Do not inherit API keys, Pi session variables, or the real home directory.
				const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432)$/iu.test(key)));
				Object.assign(env, { HOME: cwd, USERPROFILE: cwd, PI_CODING_AGENT_DIR: join(cwd, "agent"), NO_COLOR: "1" });
				const child = spawnSync(process.execPath, [script, "--worker", manifest, order, mode, outcome], { cwd, env, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024 });
				await writeFile(join(cwd, "process.log"), child.stdout + child.stderr);
				let detail; try { detail = await json(join(cwd, "result.json")); } catch { detail = { status: "failed", reason: child.error?.code ?? "missing-result" }; }
				cases.push({ name, exitCode: child.status, ...detail });
				console.log(`${name}: ${child.status === 0 && detail.status === "passed" ? "passed" : "FAILED"}`);
			}
		}
	}
	const authAfter = await stat(join(host, "auth.json"));
	const unchanged = JSON.stringify(before) === JSON.stringify(await snapshot()) && authBefore.size === authAfter.size && authBefore.mtimeMs === authAfter.mtimeMs;
	const passed = unchanged && cases.every((item) => item.status === "passed" && item.exitCode === 0);
	await writeFile(join(root, "report.json"), JSON.stringify({ status: passed ? "passed" : "failed", packages, unchangedSettingsAndAuthMetadata: unchanged, cases, limitations: ["No real model or remote compact calls", "Review decisions and native summaries are synthetic", "No interactive TUI, active Plan/Goal/BTW workflows, or web/search-tool execution", "No project-local extensions/skills/MCP discovery"] }, null, 2));
	process.exitCode = passed ? 0 : 1;
} else {
	const [, , , manifestPath, order, mode, outcome] = process.argv;
	const cwd = process.cwd(); const agentDir = process.env.PI_CODING_AGENT_DIR;
	await mkdir(agentDir, { recursive: true });
	const result = { status: "running", networkAttempts: 0, extensionErrors: [] };
	let session;
	try {
		// Install process-local guards before importing Pi or any installed extension.
		const denyNetwork = () => { result.networkAttempts++; throw new Error("Offline fixture prohibits network I/O"); };
		globalThis.fetch = denyNetwork;
		for (const name of ["node:http", "node:https", "node:tls", "node:net"]) {
			const module = (await import(name)).default;
			for (const key of ["request", "get", "connect", "createConnection"]) if (typeof module[key] === "function") module[key] = denyNetwork;
			if (name === "node:net") module.Socket.prototype.connect = denyNetwork;
		}
		(await import("node:module")).syncBuiltinESMExports();
		const Pi = await import("@earendil-works/pi-coding-agent");
		const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
		assert.equal(typeof Pi.createPowerShellToolDefinition, "function", "Pi 1.2 is required");
		const { packages, configs } = await json(manifestPath);
		for (const [file, config] of Object.entries(configs)) await writeFile(join(agentDir, file), JSON.stringify(config));
		const allEnabled = mode !== "conservative";
		await writeFile(join(agentDir, "sol-pi.json"), JSON.stringify({ version: 1, actionFusion: true, actionFusionShell: "powershell", observationPack: true, evidencePreservingReducer: allEnabled, evidencePreservingReducerProvider: "installed-reducer", evidencePreservingReducerModel: "fixture", onlineContextCompact: allEnabled, cacheWriteReadRatio: 0 }));
		const main = fauxProvider({ provider: "installed-main", api: "installed-main-api", models: [{ id: "fixture", contextWindow: 4096, maxTokens: 1024 }] });
		const reducer = fauxProvider({ provider: "installed-reducer", api: "installed-reducer-api", models: [{ id: "fixture", maxTokens: 2048 }] });
		const reviewConfig = configs["pi-auto-review.json"];
		const reviewer = fauxProvider({ provider: reviewConfig.provider, api: "installed-review-api", models: [{ id: reviewConfig.model, maxTokens: 1024 }] });
		reviewer.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage(JSON.stringify({ outcome: "allow", risk_level: "low", read_only: false, rationale: "Synthetic offline fixture approval; not a policy quality test" }))));
		reducer.setResponses([(context) => {
			const hash = JSON.stringify(context.messages).match(/source_sha256=([a-f0-9]{64})/u)?.[1]; assert.ok(hash);
			return fauxAssistantMessage(JSON.stringify({ schema: "sol-pi-evidence-receipt/1", source_sha256: hash, status: "success", uncertain: false, evidence: [{ kind: "summary", quote: "SUCCESS synthetic diagnostic" }] }));
		}]);
		const command = "function npm { 1..2500 | ForEach-Object { 'synthetic diagnostic padding line' }; 'SUCCESS synthetic diagnostic' }; npm test";
		const toolName = mode === "independent" ? "powershell" : "write";
		const shellCall = fauxAssistantMessage(fauxToolCall(toolName, mode === "independent" ? { command } : { path: "output.txt", content: "synthetic", then_run: { command } }), { stopReason: "toolUse" });
		const plan = (status) => fauxAssistantMessage(fauxToolCall("update_plan", { steps: [{ id: "work", goal: "test fixture", status }] }), { stopReason: "toolUse" });
		let phase = "main"; let summaryCalls = 0;
		const finishOrSummarize = () => {
			if (phase !== "compact") return fauxAssistantMessage("finished once");
			summaryCalls++;
			if (outcome === "cancel") { session.abortCompaction(); return fauxAssistantMessage("", { stopReason: "aborted" }); }
			return fauxAssistantMessage("Synthetic native compaction summary");
		};
		main.setResponses(allEnabled ? [plan("in_progress"), shellCall, plan("completed"), ...Array.from({ length: 8 }, () => finishOrSummarize)] : [shellCall, fauxAssistantMessage("finished once")]);
		const settingsManager = Pi.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 150, reserveTokens: 1024 }, retry: { enabled: false } }, { projectTrusted: true });
		const manager = Pi.SessionManager.inMemory(cwd);
		if (allEnabled) for (let i = 0; i < 80; i++) {
			manager.appendMessage({ role: "user", content: `synthetic old turn ${i} ` + "old data ".repeat(300), timestamp: i + 1 });
			manager.appendMessage(fauxAssistantMessage("old synthetic work ".repeat(300)));
		}
		const runtime = await Pi.ModelRuntime.create({ credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error("Credential writes prohibited"); }, delete: async () => { throw new Error("Credential deletes prohibited"); } }, modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false });
		const selectedPackages = order === "control" ? packages.filter((item) => item.replaced) : packages;
		const paths = selectedPackages.flatMap((item) => item.entries); if (order === "reversed") paths.reverse();
		const loader = new Pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: paths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [{ name: "offline-fixtures", factory: (pi) => { pi.registerProvider(main.provider); pi.registerProvider(reducer.provider); pi.registerProvider(reviewer.provider); pi.registerTool(Pi.createPowerShellToolDefinition(cwd)); pi.on("session_before_compact", () => { phase = "compact"; }); pi.on("session_compact", () => { phase = "main"; }); } }],
		});
		await loader.reload();
		result.loadErrors = loader.getExtensions().errors;
		assert.deepEqual(result.loadErrors, []);
		result.loadedExtensions = loader.getExtensions().extensions.map((extension) => extension.path);
		assert.ok(result.loadedExtensions.length >= selectedPackages.length);
		({ session } = await Pi.createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: main.getModel(), thinkingLevel: "off", resourceLoader: loader, settingsManager, sessionManager: manager }));
		await session.bindExtensions({ mode: "rpc", onError: (error) => result.extensionErrors.push({ event: error.event, error: error.error }) });
		result.tools = session.getAllTools().map((tool) => tool.name);
		assert.equal(new Set(result.tools).size, result.tools.length);
		const expectedTools = order === "control" ? ["write", "edit", "powershell", "obs_recall", "update_plan"] : ["write", "edit", "powershell", "todo", "ask_user_question", "plan_mode_question", "plan_mode_complete", "goal_complete", "goal_wait", "rg_files", "rg_search", "everything_search", "web_enable", "obs_recall"];
		for (const name of expectedTools) assert.ok(result.tools.includes(name), `Missing tool ${name}`);
		await session.prompt("Run the synthetic diagnostic in this temporary workspace only, and finish the test.", { expandPromptTemplates: false });
		const entries = manager.getEntries();
		const diagnostic = entries.find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === toolName)?.message;
		assert.ok(diagnostic); assert.equal(diagnostic.isError, false, JSON.stringify(diagnostic.content));
		if (allEnabled) {
			assert.match(JSON.stringify(diagnostic.content), /sol_pi_evidence_receipt_v1/u);
			assert.match(JSON.stringify(diagnostic.content), /SUCCESS synthetic diagnostic/u);
			assert.doesNotMatch(JSON.stringify(diagnostic.content), /padding line/u);
		}
		result.reducerCalls = reducer.state.callCount; result.reviewerCalls = reviewer.state.callCount;
		assert.equal(result.reducerCalls, allEnabled ? 1 : 0);
		result.compactions = entries.filter((entry) => entry.type === "compaction").length;
		result.continuations = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "sol-pi-online-context-compact").length;
		assert.equal(result.compactions, allEnabled && outcome === "success" ? 1 : 0);
		assert.equal(result.continuations, result.compactions);
		assert.equal(session.isIdle, true);
		if (outcome === "cancel") { assert.equal(main.state.callCount, 3 + summaryCalls); phase = "main"; await session.prompt("Continue after the cancelled synthetic compaction.", { expandPromptTemplates: false }); }
		result.summaryCalls = summaryCalls; result.mainCalls = main.state.callCount;
		assert.equal(session.getLastAssistantText(), "finished once");
		assert.equal(main.state.callCount, allEnabled ? 4 + summaryCalls : 2);
		await session.extensionRunner.emit({ type: "session_shutdown" });
		assert.deepEqual(result.extensionErrors, []);
		assert.equal(result.networkAttempts, 0);
		result.status = "passed";
	} catch (error) {
		result.status = "failed"; result.reason = error instanceof Error ? error.message : "Unknown fixture error";
		process.exitCode = 1;
	} finally {
		session?.dispose();
		await writeFile(join(cwd, "result.json"), JSON.stringify(result, null, 2));
	}
}

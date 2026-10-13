/* SPDX-License-Identifier: MIT */
// Deliberately opt-in; run with Node >=22.19 and isolated Pi 1.2 dependencies.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Pi from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createActionFusionExtension } from "../src/sol-pi/extensions/action-fusion/index.ts";
import { reduceToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import { loadReducerConfig } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { createOnlineContextCompactExtension } from "../src/sol-pi/extensions/online-context-compact/extension.ts";
import { createLiveBudget, LiveGateError } from "./live-budget.ts";

const argv = process.argv.slice(2);
if (![5, 7].includes(argv.length) || argv[0] !== "--allow-live" || argv[1] !== "--provider" || argv[3] !== "--model" || (argv.length === 7 && argv[5] !== "--resume-report")) {
	throw new Error("Opt-in required: node scripts/check-epr-occ-live.mjs --allow-live --provider <provider> --model <model>");
}
const providerId = argv[2], modelId = argv[4];
const previous = argv[6] ? JSON.parse(await readFile(resolve(argv[6]), "utf8")) : undefined;
if (previous && (previous.provider !== providerId || previous.model !== modelId || previous.phase !== "local-plan" || previous.reason !== "LIFECYCLE_NOT_VERIFIED" || previous.requests?.length !== 2 || previous.checks?.length !== 2 || previous.requests.some((item, i) => item.phase !== ["epr-fused", "epr-independent"][i] || item.status !== 200) || previous.checks.some((item, i) => item.phase !== ["epr-fused", "epr-independent"][i] || item.ok !== true))) throw new LiveGateError("RESUME_DENIED");
const previousElapsed = previous ? previous.elapsedMs ?? Math.max(0, (await stat(resolve(argv[6]))).mtimeMs - (await stat(dirname(resolve(argv[6])))).birthtimeMs) : 0;
if (!Number.isFinite(previousElapsed) || previousElapsed < 0 || previousElapsed >= 360_000) throw new LiveGateError("TOTAL_DEADLINE");
const remainingMs = 360_000 - previousElapsed;
const runStarted = Date.now();
const hostAgentDir = Pi.getAgentDir();
const root = await mkdtemp(join(tmpdir(), "sol-pi-live-"));
const report = { provider: providerId, model: modelId, status: "running", checks: previous?.checks ?? [], requests: [], usage: previous?.usage ?? [] };
console.log(`Live validation report: ${join(root, "report.json")}`);
const originalFetch = globalThis.fetch;
const ledgerPath = join(previous ? dirname(resolve(argv[6])) : root, "request-ledger.json");
const ledgerLock = openSync(`${ledgerPath}.lock`, "wx", 0o600);
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : previous?.requests ?? [];
if (previous && ledger.length !== 2) { closeSync(ledgerLock); unlinkSync(`${ledgerPath}.lock`); throw new LiveGateError("RESUME_DENIED"); }
const budget = createLiveBudget(modelId, originalFetch, remainingMs, ledger, (records) => writeFileSync(ledgerPath, JSON.stringify(records), { mode: 0o600 }));
globalThis.fetch = budget.fetch;
let session;
let phase = "preflight";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
// Hard process-level deadline includes hanging providers and response consumption.
const timer = setTimeout(() => {
	console.error("Live validation stopped: TOTAL_DEADLINE"); process.exit(1);
}, remainingMs);
try {
	if (typeof Pi.readStoredCredential !== "function" || !Pi.ModelRuntime || typeof Pi.createPowerShellToolDefinition !== "function") throw new LiveGateError("PI_1_2_REQUIRED");
	const credentials = {
		async read(id) {
			if (id !== providerId) return undefined;
			const value = Pi.readStoredCredential(id, join(hostAgentDir, "auth.json"));
			if (value?.type === "oauth" && value.expires < Date.now() + 360_000) throw new LiveGateError("AUTH_REFRESH_REQUIRED");
			return value;
		},
		async list() { const value = await this.read(providerId); return value ? [{ providerId, type: value.type }] : []; },
		async modify() { throw new LiveGateError("CREDENTIAL_MUTATION_DENIED"); },
		async delete() { throw new LiveGateError("CREDENTIAL_MUTATION_DENIED"); },
	};
	const runtime = await Pi.ModelRuntime.create({ credentials, modelsPath: join(hostAgentDir, "models.json"), modelsStorePath: join(root, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false, signal: budget.signal });
	const model = runtime.getModel(providerId, modelId);
	if (!model || model.api !== "openai-responses") throw new LiveGateError("MODEL_ROUTE_UNAVAILABLE");
	const auth = await runtime.getAuth(model, { signal: budget.signal, minOAuthValidityMs: 360_000 });
	if (!auth) throw new LiveGateError("AUTH_UNAVAILABLE");
	budget.setEndpoint(auth.auth.baseUrl ?? model.baseUrl);
	const provider = runtime.getProvider(providerId);
	if (!provider) throw new LiveGateError("PROVIDER_UNAVAILABLE");
	let localTurns = 0;
	const usages = report.usage;
	const wrappedProvider = new Proxy(provider, {
		get(target, key) {
			if (key === "stream" || key === "streamSimple") return (selectedModel, context, options = {}) => {
				if (selectedModel.id !== modelId || selectedModel.provider !== providerId) throw new LiveGateError("MODEL_MISMATCH");
				if (phase === "local-plan") {
					if (++localTurns > 2) throw new LiveGateError("UNEXPECTED_LOCAL_TURN");
					report.localPlanTurns = localTurns;
					const stream = createAssistantMessageEventStream();
					const message = fauxAssistantMessage(fauxToolCall("update_plan", { steps: [{ id: "synthetic", goal: "verify synthetic task", status: localTurns === 1 ? "in_progress" : "completed" }] }), { stopReason: "toolUse" });
					queueMicrotask(() => { stream.push({ type: "done", reason: "toolUse", message }); stream.end(); });
					return stream;
				}
				budget.arm(phase);
				const requestPhase = phase;
				const underlying = target[key](selectedModel, context, {
					...options, signal: AbortSignal.any([budget.signal, AbortSignal.timeout(90_000), ...(options.signal ? [options.signal] : [])]),
					maxTokens: 2048, maxRetries: 0, timeoutMs: 90_000, transport: "sse", fetch: budget.fetch,
					onPayload: async (payload, actualModel) => {
						const prepared = await options.onPayload?.(payload, actualModel) ?? payload;
						if (!prepared || typeof prepared !== "object" || prepared.model !== modelId) throw new LiveGateError("PAYLOAD_MODEL_MISMATCH");
						return { ...prepared, max_output_tokens: 2048 };
					},
				});
				const observed = createAssistantMessageEventStream();
				void (async () => {
					try {
						for await (const event of underlying) {
							if (event.type === "done") usages.push({ phase: requestPhase, usage: event.message.usage });
							observed.push(event);
						}
					} catch {
						observed.push({ type: "error", reason: "error", error: fauxAssistantMessage("", { stopReason: "error", errorMessage: "Live provider stream failed" }) });
					} finally { observed.end(); }
				})();
				return observed;
			};
			const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
		},
	});
	runtime.registerNativeProvider(wrappedProvider);
	const agentDir = join(root, "agent"); await mkdir(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const registry = new Pi.ModelRegistry(runtime);
	const manager = Pi.SessionManager.inMemory(root);
	const context = { cwd: root, hasUI: false, mode: "json", signal: budget.signal, sessionManager: manager, modelRegistry: registry, model, ui: {} };
	const registered = new Map();
	createActionFusionExtension({ shell: "powershell" })({ registerTool: (tool) => registered.set(tool.name, tool) });
	const command = "function npm { 1..160 | ForEach-Object { 'synthetic diagnostic padding for controlled validation' }; 'SUCCESS: 160 synthetic checks passed' }; npm test";
	const config = loadReducerConfig(root, { reducerProvider: providerId, reducerModel: modelId });
	for (const kind of previous ? [] : ["epr-fused", "epr-independent"]) {
		phase = kind;
		const tool = kind === "epr-fused" ? registered.get("write") : Pi.createPowerShellToolDefinition(root);
		const input = kind === "epr-fused" ? { path: "synthetic.txt", content: "synthetic fixture only", then_run: { command } } : { command };
		const output = await tool.execute(kind, input, budget.signal, undefined, context);
		if (output.isError) throw new LiveGateError("SYNTHETIC_TOOL_FAILED");
		const event = { type: "tool_result", toolName: tool.name, toolCallId: kind, input, ...output, isError: false };
		const reduced = await reduceToolResult(() => {}, config, event, context);
		if (!reduced || !JSON.stringify(reduced.content).includes("sol_pi_evidence_receipt_v1")) throw new LiveGateError("EPR_NOT_APPLIED");
		report.checks.push({ phase, ok: true, sourceSha256: reduced.details.evidencePreservingReducer.sourceSha256 });
		budget.disarm();
	}
	phase = "local-plan";
	manager.appendMessage({ role: "user", content: "Synthetic completed tests and remaining verification. ".repeat(160), timestamp: 1 });
	manager.appendMessage(fauxAssistantMessage("Synthetic implementation and verification notes. ".repeat(160)));
	// Retain a whole synthetic turn so native compaction needs only one summary call.
	manager.appendMessage({ role: "user", content: "Synthetic retained request. ".repeat(240), timestamp: 2 });
	manager.appendMessage(fauxAssistantMessage("Retained synthetic acknowledgement."));
	const settings = Pi.SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1024, reserveTokens: 2048 }, retry: { enabled: false } }, { projectTrusted: true });
	const loader = new Pi.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "This is a synthetic compatibility check. After compaction, reply briefly that verification is complete. Do not call any tools after compaction.",
		extensionFactories: [{ name: "live-occ-fixture", factory: (pi) => {
			pi.registerProvider(wrappedProvider);
			const fixturePi = new Proxy(pi, { get(target, key) {
				if (key === "on") return (name, handler) => target.on(name, (event, ctx) => handler(event, new Proxy(ctx, { get(value, field) {
					if (field === "getContextUsage") return () => ({ tokens: 195000, contextWindow: 200000, percent: 97.5 });
					const result = Reflect.get(value, field); return typeof result === "function" ? result.bind(value) : result;
				} })));
				const result = Reflect.get(target, key); return typeof result === "function" ? result.bind(target) : result;
			} });
			createOnlineContextCompactExtension({ cacheWriteReadRatio: 0, keepRecentTokens: 1024 })(fixturePi);
			pi.on("session_before_compact", () => { phase = "native-compaction"; });
			pi.on("session_compact", () => { report.checks.push({ phase: "native-compaction", ok: true }); phase = "continuation"; pi.setActiveTools([]); });
		} }],
	});
	await loader.reload(); if (loader.getExtensions().errors.length) throw new LiveGateError("EXTENSION_LOAD_FAILED");
	// Artificially small LOCAL window forces a boundary in the fixture; model routing is unchanged.
	({ session } = await Pi.createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, model: { ...model, contextWindow: 4096 }, thinkingLevel: "off", tools: ["update_plan"], resourceLoader: loader, settingsManager: settings, sessionManager: manager }));
	await session.prompt("Finish the synthetic verification plan.", { expandPromptTemplates: false });
	if (!session.isIdle || !session.getLastAssistantText() || !report.checks.some((item) => item.phase === "native-compaction") || budget.records.length !== 4 || budget.records.some((item) => item.status !== 200)) throw new LiveGateError("LIFECYCLE_NOT_VERIFIED");
	report.usageCoverage = usages.map((item) => item.phase);
	report.checks.push({ phase: "continuation", ok: true }); report.usage = usages; report.status = "passed";
} catch (error) {
	report.status = "blocked_or_failed"; report.phase = phase;
	// Never emit provider error text, URLs, request bodies, auth values, or stack traces.
	report.reason = error instanceof LiveGateError ? error.code : "VALIDATION_FAILED";
	process.exitCode = 1;
} finally {
	budget.disarm(); session?.dispose(); clearTimeout(timer); globalThis.fetch = originalFetch;
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	closeSync(ledgerLock); unlinkSync(`${ledgerPath}.lock`);
	report.denials = budget.denials;
	report.elapsedMs = previousElapsed + Date.now() - runStarted;
	report.requests = budget.records;
	await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report));
}

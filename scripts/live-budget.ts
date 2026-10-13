/* SPDX-License-Identifier: MIT */
export const LIVE_PHASES = ["epr-fused", "epr-independent", "native-compaction", "continuation"] as const;
export type LivePhase = (typeof LIVE_PHASES)[number];
export class LiveGateError extends Error {
	readonly code: string;
	constructor(code: string) { super(code); this.code = code; }
}
/** Opt-in test infrastructure only; never imported by the extension. */
export function createLiveBudget(model: string, transport: typeof fetch, totalMs = 360_000, previous: { phase: LivePhase; bytes: number; status?: number }[] = [], persist?: (records: readonly { phase: LivePhase; bytes: number; status?: number }[]) => void) {
	if (!Number.isFinite(totalMs) || totalMs < 1 || totalMs > 360_000) throw new LiveGateError("INVALID_DEADLINE");
	totalMs = Math.floor(totalMs);
	const started = Date.now();
	const deadline = AbortSignal.timeout(totalMs);
	let endpoint: string | undefined;
	let phase: LivePhase | undefined;
	if (previous.length > 4 || previous.some((item) => !LIVE_PHASES.includes(item.phase) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 65536) || new Set(previous.map((item) => item.phase)).size !== previous.length) throw new LiveGateError("INVALID_REQUEST_LEDGER");
	const records: { phase: LivePhase; bytes: number; status?: number }[] = previous.map((item) => ({ ...item }));
	const used = new Set<LivePhase>(records.map((item) => item.phase));
	const fetchGuard: typeof fetch = async (input, init) => {
		if (deadline.aborted || Date.now() - started >= totalMs) throw new LiveGateError("TOTAL_DEADLINE");
		if (!phase || !endpoint) throw new LiveGateError("UNARMED_NETWORK");
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.href !== endpoint || url.pathname.endsWith("/compact") || url.protocol !== "https:") throw new LiveGateError("ENDPOINT_DENIED");
		if (init?.method !== "POST" || typeof init.body !== "string") throw new LiveGateError("REQUEST_FORMAT_DENIED");
		const bytes = Buffer.byteLength(init.body, "utf8");
		if (bytes > 64 * 1024) throw new LiveGateError("INPUT_LIMIT");
		let payload: Record<string, unknown>;
		try { payload = JSON.parse(init.body); } catch { throw new LiveGateError("INVALID_JSON"); }
		if (!payload || payload.model !== model) throw new LiveGateError("MODEL_MISMATCH");
		if (!Number.isSafeInteger(payload.max_output_tokens) || Number(payload.max_output_tokens) < 1 || Number(payload.max_output_tokens) > 2048) throw new LiveGateError("OUTPUT_LIMIT_UNENFORCEABLE");
		if (records.length >= 4 || used.has(phase)) throw new LiveGateError("REQUEST_BUDGET_EXHAUSTED");
		used.add(phase);
		const record: (typeof records)[number] = { phase, bytes }; records.push(record);
		persist?.(records); // Reserve durably before dispatch; a crash must not reset the allowance.
		const signal = AbortSignal.any([deadline, AbortSignal.timeout(90_000), ...(init.signal ? [init.signal] : [])]);
		const response = await transport(input, { ...init, redirect: "error", signal });
		record.status = response.status;
		persist?.(records);
		return response;
	};
	const denials: string[] = [];
	return {
		fetch: (async (input, init) => {
			try { return await fetchGuard(input, init); }
			catch (error) { if (error instanceof LiveGateError) denials.push(error.code); throw error; }
		}) as typeof fetch,
		records, denials, signal: deadline,
		setEndpoint(baseUrl: string) {
			const url = new URL(`${baseUrl.replace(/\/$/u, "")}/responses`);
			if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new LiveGateError("INVALID_ENDPOINT");
			endpoint = url.href;
		},
		arm(value: LivePhase) { if (!LIVE_PHASES.includes(value)) throw new LiveGateError("INVALID_PHASE"); phase = value; },
		disarm() { phase = undefined; },
	};
}

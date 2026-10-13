/* SPDX-License-Identifier: MIT */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createActionFusionExtension } from "../src/sol-pi/extensions/action-fusion/index.ts";
import { checkPowerShell, runPowerShell } from "../src/sol-pi/extensions/action-fusion/powershell.ts";
import { DEFAULT_CONFIG, loadSolPiConfig } from "../src/sol-pi/config.ts";

import type { ToolExecutionContext } from "../src/sol-pi/tool-context.ts";

const roots: string[] = [];
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "sol-pi-한글 '$-")); roots.push(root); return root;
}
function tools() {
	const registered = new Map<string, ToolDefinition>();
	createActionFusionExtension({ shell: "powershell" })({ registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool) } as unknown as ExtensionAPI);
	return registered;
}
function ctx(cwd: string) { return { cwd, hasUI: false, mode: "json" } as ToolExecutionContext; }
function text(value: { content: Array<{ type: string; text?: string }> }) { return value.content.map((item) => item.text ?? "").join("\n"); }
function collectLog(output: string) {
	const path = output.match(/Full output: ([^\r\n\]]+)/)?.[1];
	if (path) roots.push(dirname(path));
	return path;
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("validates shell configuration identically in runtime and preflight", async () => {
	const cwd = await fixture();
	for (const shell of [undefined, "bash", "powershell", "cmd", null, 1]) {
		const config = join(cwd, "sol-pi.json");
		await writeFile(config, JSON.stringify({ version: 1, ...(shell === undefined ? {} : { actionFusionShell: shell }) }));
		const result = spawnSync(process.execPath, ["scripts/check-sol-pi-config.mjs", "--config", config], { encoding: "utf8" });
		if (shell === undefined || shell === "bash" || shell === "powershell") {
			expect(result.status).toBe(0);
			expect(loadSolPiConfig(cwd, cwd).actionFusionShell).toBe(shell ?? "bash");
			expect(JSON.parse(result.stdout).effective_config.actionFusionShell).toBe(shell ?? "bash");
		} else {
			expect(result.status).not.toBe(0);
			expect(() => loadSolPiConfig(cwd, cwd)).toThrow("actionFusionShell");
		}
	}
	expect(DEFAULT_CONFIG.actionFusionShell).toBe("bash");
	expect(() => createActionFusionExtension({ shell: "powershell", bashOptions: {} })).toThrow("bashOptions");
});

const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "Write-Output $PSHOME"], { encoding: "utf8" });
const available = probe.status === 0;
describe.skipIf(!available)("native PowerShell 7", () => {
	it("executes fused write and edit with Unicode, CRLF, BOM and no Bash", async () => {
		const cwd = await fixture();
		const registered = tools();
		const write = registered.get("write")!;
		const edit = registered.get("edit")!;
		const content = "\ufeff첫째\r\n둘째\r\n";
		vi.stubEnv("SOL_PI_PWSH_TEST", "inherited-value");
		// Only pwsh is discoverable: no Bash launcher is available on PATH.
		vi.stubEnv("PATH", probe.stdout.trim());
		const result = await write.execute("write", { path: "한글 '$.txt", content, then_run: { command: "Get-Location; Get-Content -LiteralPath \"한글 '`$.txt\"; Write-Output $env:SOL_PI_PWSH_TEST" } }, undefined, undefined, ctx(cwd));
		expect(text(result)).toContain("[then_run:succeeded]");
		expect(text(result)).toContain("inherited-value");
		expect(await readFile(join(cwd, "한글 '$.txt"), "utf8")).toBe(content);
		const edited = await edit.execute("edit", { path: "한글 '$.txt", edits: [{ oldText: "둘째", newText: "셋째" }], then_run: { command: "Write-Output '수정 완료'" } }, undefined, undefined, ctx(cwd));
		expect(text(edited)).toContain("수정 완료");
	}, 20_000);

	it.each(["throw 'failure'", "Write-Error 'failure'", "exit 7", "node -e 'process.exit(9)'"])("preserves mutation after command failure: %s", async (command) => {
		const cwd = await fixture();
		try {
			await tools().get("write")!.execute("write", { path: "file", content: "retained", then_run: { command } }, undefined, undefined, ctx(cwd));
			throw new Error("expected failure");
		} catch (error) {
			expect(String(error)).toContain("[then_run:failed]");
			const log = collectLog(String(error)); expect(log).toBeDefined();
			expect(await readdir(dirname(log!))).toEqual(["output.log"]);
		}
		expect(await readFile(join(cwd, "file"), "utf8")).toBe("retained");
	}, 15_000);

	it("rejects missing pwsh and invalid timeout before mutation", async () => {
		const cwd = await fixture();
		for (const timeout of [0, -1, Infinity, NaN]) await expect(checkPowerShell({ command: "exit", timeout })).rejects.toThrow("timeout");
		vi.stubEnv("PATH", cwd);
		await expect(tools().get("write")!.execute("write", { path: "file", content: "no", then_run: { command: "exit" } }, undefined, undefined, ctx(cwd))).rejects.toThrow("required");
		expect(await readdir(cwd)).toEqual([]);
	});

	it("archives large Unicode stdout/stderr and deletes the script", async () => {
		const cwd = await fixture();
		const output = await runPowerShell({ command: "1..2500 | ForEach-Object { '한글' * 30 }; [Console]::Error.WriteLine('stderr-end'); Write-Output 'stdout-end'" }, cwd);
		const log = collectLog(output)!;
		expect(output).toContain("Output truncated");
		expect(output).not.toContain("\ufffd");
		expect(Buffer.byteLength(output.split("\n[Output truncated")[0]!)).toBeLessThanOrEqual(50 * 1024);
		const full = await readFile(log, "utf8");
		expect(full).toContain("stderr-end"); expect(full).toContain("stdout-end");
		expect(Buffer.byteLength(full)).toBeGreaterThan(50 * 1024);
		expect(await readdir(dirname(log))).toEqual(["output.log"]);
	}, 15_000);

	it("cancels before mutation", async () => {
		const cwd = await fixture(); const controller = new AbortController(); controller.abort();
		await expect(tools().get("write")!.execute("write", { path: "file", content: "no", then_run: { command: "exit" } }, controller.signal, undefined, ctx(cwd))).rejects.toThrow("then_run:skipped");
		expect(await readdir(cwd)).toEqual([]);
	});

	it.each(["timeout", "cancel"])("terminates the running process tree on %s", async (mode) => {
		const cwd = await fixture(); const controller = new AbortController();
		const command = "$p = Start-Process pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -PassThru; $p.Id | Set-Content child.pid; Start-Sleep 60";
		const pending = runPowerShell({ command, ...(mode === "timeout" ? { timeout: 3 } : {}) }, cwd, controller.signal);
		// Observe rejection immediately while polling the child marker.
		const outcome = pending.then(() => "unexpected success", (error: unknown) => String(error));
		for (let i = 0; i < 100; i++) {
			if ((await readdir(cwd)).includes("child.pid")) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (mode === "cancel") controller.abort();
		const error = await outcome;
		expect(error).toContain(mode === "timeout" ? "timed out" : "cancelled");
		collectLog(error);
		const pid = Number((await readFile(join(cwd, "child.pid"), "utf8")).trim());
		expect(() => process.kill(pid, 0)).toThrow();
	}, 15_000);
});

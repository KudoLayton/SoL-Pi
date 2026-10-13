/* SPDX-License-Identifier: MIT */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { reducibleToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts";
import { archiveBody } from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";
import { DIAGNOSTIC_COMMAND, sha256 } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { clearArtifacts, rememberArtifact, takeArtifact } from "../src/sol-pi/extensions/action-fusion/artifacts.ts";
import { runPowerShell } from "../src/sol-pi/extensions/action-fusion/powershell.ts";
const roots: string[] = [];
const session = "epr-windows-safety";
afterEach(async () => { clearArtifacts(session); await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))); });
async function root(prefix = "epr-safety-") { const dir = await mkdtemp(join(tmpdir(), prefix)); roots.push(dir); return dir; }
function event(overrides: Record<string, unknown> = {}): ToolResultEvent {
	return { type: "tool_result", toolName: "powershell", toolCallId: "call", input: { command: "dotnet test" }, content: [{ type: "text", text: "inline" }], isError: false, details: undefined, ...overrides } as ToolResultEvent;
}
it.each(["npm.cmd test", "dotnet build", "dotnet test", "MSBuild.exe /t:Build", '& "C:\\Program Files\\nodejs\\npm.cmd" test', "& 'C:\\SDK\\dotnet.exe' test"])("recognizes diagnostic PowerShell command %s", (command) => expect(DIAGNOSTIC_COMMAND.test(command)).toBe(true));
it.each(["Get-ChildItem", "Write-Output hello", "rg test src"])("does not broaden diagnostic scope to %s", (command) => expect(DIAGNOSTIC_COMMAND.test(command)).toBe(false));
it("recovers complete Pi PowerShell output and preserves structured status", async () => {
	const path = join(tmpdir(), `pi-powershell-${randomUUID()}.log`); roots.push(path);
	const body = "\ufeff한글\r\n".repeat(1000); await writeFile(path, body);
	const candidate = await reducibleToolResult(event({ details: { fullOutputPath: path }, structuredContent: { output: "inline", truncated: true, full_output_path: path, exit_code: 7, wall_time_seconds: 1 }, isError: true }));
	expect(candidate?.body).toBe(body);
	expect(candidate?.projectStructured?.("receipt")).toEqual({ output: "receipt", truncated: true, full_output_path: path, exit_code: 7, wall_time_seconds: 1 });
});
it("does not trust a PowerShell path printed in text or normalize corrupt UTF-8", async () => {
	const path = join(tmpdir(), `pi-powershell-${randomUUID()}.log`); roots.push(path);
	await writeFile(path, Buffer.from([0xc3, 0x28]));
	await expect(reducibleToolResult(event({ details: { fullOutputPath: path } }))).rejects.toThrow("UTF-8");
	await writeFile(path, "valid but not authorized by metadata");
	await expect(reducibleToolResult(event({ content: [{ type: "text", text: `Full output: ${path}` }] }))).rejects.toThrow("Missing full shell log");
});

it("skips unknown structured schemas", async () => {
	expect(await reducibleToolResult(event({ structuredContent: { output: "secret", special: true } }))).toBeUndefined();
});
it("rejects untrusted, missing, oversized and junction-hosted full logs", async () => {
	const directory = await root(); const target = join(directory, "pi-powershell-fake.log"); await writeFile(target, "outside");
	await expect(reducibleToolResult(event({ details: { fullOutputPath: target } }))).rejects.toThrow();
	const path = join(tmpdir(), `pi-powershell-${randomUUID()}.log`); roots.push(path); await writeFile(path, "large".repeat(100));
	await expect(reducibleToolResult(event({ details: { fullOutputPath: path } }), undefined, 10)).rejects.toThrow("size limit");
	await rm(path);
	await expect(reducibleToolResult(event({ details: { fullOutputPath: path } }))).rejects.toThrow();
	await expect(reducibleToolResult(event({ content: [{ type: "text", text: "[Output truncated]" }] }))).rejects.toThrow();
	const linked = join(directory, "linked"); await symlink(tmpdir(), linked, process.platform === "win32" ? "junction" : "dir");
	await writeFile(path, "source");
	await expect(reducibleToolResult(event({ details: { fullOutputPath: join(linked, path.split(/[\\/]/u).at(-1)!) } }))).rejects.toThrow();
});
it.each([true, false])("reads only registered complete ActionFusion artifacts (complete=%s)", async (complete) => {
	const directory = await root("sol-pi-pwsh-"); const path = join(directory, "output.log"); const body = "full diagnostic\r\n"; await writeFile(path, body);
	const record = { version: 1 as const, toolCallId: "call", path, bytes: Buffer.byteLength(body), sha256: sha256(body), complete };
	const fused = event({ toolName: "write", input: { then_run: { command: "npm test" } }, details: { actionFusionArtifact: record }, content: [{ type: "text", text: "written\n[then_run:failed]\npreview" }], isError: true });
	expect(await reducibleToolResult(fused, session)).toBeUndefined();
	rememberArtifact(session, record);
	const candidate = await reducibleToolResult(fused, session);
	if (complete) { expect(candidate?.body).toBe(body); expect(candidate?.projectReceipt("receipt")).toEqual([{ type: "text", text: "written\n[then_run:failed]\nreceipt" }]); }
	else expect(candidate).toBeUndefined();
	expect(takeArtifact(session, "call")).toBeUndefined();
	rememberArtifact(session, record); await writeFile(path, "replacement");
	expect(await reducibleToolResult(fused, session)).toBeUndefined();
});
it("bounds artifact references and isolates sessions/call IDs", () => {
	for (let i = 0; i < 257; i++) rememberArtifact(session, { version: 1, toolCallId: String(i), path: "unused", bytes: 0, sha256: "", complete: true });
	expect(takeArtifact(session, "0")).toBeUndefined();
	expect(takeArtifact("other", "256")).toBeUndefined();
	expect(takeArtifact(session, "256")).toBeDefined();
	clearArtifacts(session); expect(takeArtifact(session, "1")).toBeUndefined();
});
it("rejects archive junctions and modified existing archive content", async () => {
	const directory = await root(); const body = "\ufeffarchive\r\n";
	const archive = await archiveBody(directory, body); expect(await readFile(archive.path, "utf8")).toBe(body);
	await writeFile(archive.path, "x".repeat(Buffer.byteLength(body)));
	await expect(archiveBody(directory, body)).rejects.toThrow("integrity");
	const other = await root(); const outside = join(other, "outside"); await mkdir(outside);
	await symlink(outside, join(other, "objects"), process.platform === "win32" ? "junction" : "dir");
	await expect(archiveBody(other, body)).rejects.toThrow();
});
it.runIf(process.platform === "win32")("captures failed native execution as a complete original artifact", async () => {
	const cwd = await root(); let artifact: Parameters<typeof rememberArtifact>[1] | undefined;
	await expect(runPowerShell({ command: "Write-Output 'original diagnostic'; exit 7" }, cwd, undefined, (record) => { artifact = { ...record, toolCallId: "call" }; roots.push(record.path.replace(/[\\/]output\.log$/u, "")); })).rejects.toThrow("code 7");
	expect(artifact?.complete).toBe(true);
	expect(sha256(await readFile(artifact!.path, "utf8"))).toBe(artifact?.sha256);
});

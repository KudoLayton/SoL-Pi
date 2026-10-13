/* SPDX-License-Identifier: MIT */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.each([["text", false], ["json", false], ["text", true], ["json", true]])("settles CLI %s with cancelled=%s", async (mode, cancel) => {
	const cwd = await mkdtemp(join(tmpdir(), "sol-pi-occ-cli-"));
	try {
		const agentDir = join(cwd, "agent"); await mkdir(agentDir);
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 150, reserveTokens: 1024 }, retry: { enabled: false } }));
		const fixture = join(cwd, "fixture.ts");
		await writeFile(fixture, `
import { writeFile } from 'node:fs/promises';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/providers/faux")))};
import { createOnlineContextCompactExtension } from ${JSON.stringify(join(process.cwd(), "src/sol-pi/extensions/online-context-compact/extension.ts"))};
export default function(pi) {
 let requests=0, compactions=0;
 const faux=fauxProvider({provider:'occ-cli-fixture',api:'occ-cli-fixture-api',models:[{id:'fixture',contextWindow:4096,maxTokens:1024}]});
 faux.setResponses([
  fauxAssistantMessage([fauxText('synthetic work '.repeat(600)),fauxToolCall('update_plan',{steps:[{id:'one',goal:'synthetic',status:'in_progress'}]})],{stopReason:'toolUse'}),
  fauxAssistantMessage(fauxToolCall('update_plan',{steps:[{id:'one',goal:'synthetic',status:'completed'}]}),{stopReason:'toolUse'}),
  fauxAssistantMessage('CLI_AFTER_COMPACTION')
 ]);
 pi.registerProvider(faux.provider);
 createOnlineContextCompactExtension({cacheWriteReadRatio:0,keepRecentTokens:150})(pi);
 pi.on('session_before_compact',event=>{requests++;return ${cancel ? "{cancel:true}" : "{compaction:{summary:'synthetic summary',firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:event.preparation.tokensBefore}}"};});
 pi.on('session_compact',()=>{compactions++;});
 pi.on('session_shutdown',async()=>{await writeFile(${JSON.stringify(join(cwd, "report.json"))},JSON.stringify({requests,compactions,calls:faux.state.callCount}));});
}
`);
		const piRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
		const pkg = JSON.parse(await readFile(join(piRoot, "package.json"), "utf8"));
		const child = promisify(execFile)(process.execPath, [join(piRoot, pkg.bin.pi), "--offline", "--approve", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", fixture, "--provider", "occ-cli-fixture", "--model", "fixture", "--thinking", "off", "--mode", String(mode), "-p", "synthetic history ".repeat(800)], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
		child.child.stdin?.end();
		const { stdout, stderr } = await child.catch((error: unknown) => {
			if (!cancel || !error || typeof error !== "object" || !("code" in error) || error.code !== 1 || !("stdout" in error) || !("stderr" in error) || !String(error.stderr).includes("aborted")) throw error;
			return { stdout: String(error.stdout), stderr: String(error.stderr) };
		});
		expect(stderr).not.toMatch(/extension.*error/iu);
		const report = JSON.parse(await readFile(join(cwd, "report.json"), "utf8"));
		expect(report).toEqual({ requests: 1, compactions: cancel ? 0 : 1, calls: cancel ? 2 : 3 });
		if (!cancel) expect(stdout).toContain("CLI_AFTER_COMPACTION");
		else expect(stdout).not.toContain("CLI_AFTER_COMPACTION");
		if (mode === "json") for (const line of stdout.trim().split(/\r?\n/u)) expect(() => JSON.parse(line)).not.toThrow();
	} finally { await rm(cwd, { force: true, recursive: true }); }
}, 30_000);

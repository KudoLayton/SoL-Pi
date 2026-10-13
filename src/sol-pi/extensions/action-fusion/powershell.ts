/* SPDX-License-Identifier: MIT */
import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import type { ThenRunInput } from "./then-run.ts";

const exec = promisify(execFile);
const LIMIT = 50 * 1024;

export async function checkPowerShell(input: ThenRunInput, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0)) {
		throw new Error("PowerShell timeout must be a finite positive number");
	}
	try {
		await exec("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }"],
			{ signal, timeout: 10_000, windowsHide: true, maxBuffer: LIMIT });
	} catch (error) {
		throw new Error("PowerShell 7 (pwsh) is required; no shell fallback is performed", { cause: error });
	}
}

export async function runPowerShell(input: ThenRunInput, cwd: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const directory = await mkdtemp(join(tmpdir(), "sol-pi-pwsh-"));
	const script = join(directory, "command.ps1");
	const log = join(directory, "output.log");
	let fd: number | undefined;
	let tail = "";
	let truncated = false;
	const append = (text: string) => {
		tail += text;
		const lines = tail.split("\n");
		if (lines.length > 2000) { tail = lines.slice(-2000).join("\n"); truncated = true; }
		const bytes = Buffer.from(tail, "utf8");
		if (bytes.length > LIMIT) {
			let start = bytes.length - LIMIT;
			while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
			tail = bytes.subarray(start).toString("utf8");
			truncated = true;
		}
	};
	try {
		await writeFile(script, "$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n$global:LASTEXITCODE = 0\n" + input.command + "\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
		fd = openSync(log, "wx", 0o600);
		signal?.throwIfAborted();
		const code = await new Promise<number | null>((resolve, reject) => {
			const child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script], {
				cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
			});
			let failure: Error | undefined;
			let termination: Promise<void> | undefined;
			const stop = (reason: Error) => {
				if (termination) return;
				failure = reason;
				termination = (async () => {
					if (!child.pid) return;
					try {
						if (process.platform === "win32") {
							await exec(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
						} else process.kill(-child.pid, "SIGKILL");
					} catch (error) {
						failure = new Error(`${reason.message}; process-tree termination failed: ${String(error)}`);
						child.kill("SIGKILL");
						// Do not wait forever for inherited pipes after a failed tree kill.
						child.stdout.destroy();
						child.stderr.destroy();
					}
				})();
			};
			const abort = () => stop(new Error("PowerShell command cancelled; preceding file change is retained"));
			signal?.addEventListener("abort", abort, { once: true });
			let timer: ReturnType<typeof setTimeout> | undefined;
			const started = performance.now();
			const scheduleTimeout = () => {
				if (input.timeout === undefined) return;
				const remaining = input.timeout * 1000 - (performance.now() - started);
				if (remaining <= 0) stop(new Error("PowerShell command timed out; preceding file change is retained"));
				else timer = setTimeout(scheduleTimeout, Math.min(remaining, 2_147_483_647));
			};
			scheduleTimeout();
			const archive = (text: string) => {
				try {
					// Decode each stream independently before interleaving: a stderr chunk
					// must never split a multi-byte stdout character in the archived log.
					const bytes = Buffer.from(text, "utf8");
					let offset = 0;
					while (offset < bytes.length) offset += writeSync(fd!, bytes, offset, bytes.length - offset);
					append(text);
				} catch (error) { stop(new Error(`Unable to archive PowerShell output: ${String(error)}`)); }
			};
			for (const stream of [child.stdout, child.stderr]) {
				const decoder = new StringDecoder("utf8");
				stream.on("data", (chunk: Buffer) => archive(decoder.write(chunk)));
				stream.on("end", () => archive(decoder.end()));
				stream.on("error", (error) => stop(error));
			}
			child.on("error", (error) => { failure = error; });
			child.on("close", (exitCode) => {
				if (timer) clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				void (async () => { await termination; if (failure) reject(failure); else resolve(exitCode); })();
			});
			if (signal?.aborted) abort();
		});
		if (code !== 0) throw new Error(`PowerShell exited with code ${code}`);
		return tail + (truncated ? `\n[Output truncated. Full output: ${log}]` : "");
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${tail}\nFull output: ${log}`);
	} finally {
		try { if (fd !== undefined) closeSync(fd); }
		finally { await rm(script, { force: true }); }
	}
}

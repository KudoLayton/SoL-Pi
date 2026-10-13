/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { readBoundedFile } from "../../safe-files.ts";
import { takeArtifact } from "../action-fusion/artifacts.ts";
import { isRecord, recordValue, sha256 } from "./config.ts";

const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type StructuredResult = { [key: string]: JsonValue };
function isJsonValue(value: unknown, depth = 0): value is JsonValue {
	if (depth > 32) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
	return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}
export interface ReducibleToolResult {
	readonly command: string;
	readonly body: string;
	readonly projectReceipt: (receipt: string) => ToolResultEvent["content"];
	readonly projectStructured?: (receipt: string) => StructuredResult;
}
function textContent(event: ToolResultEvent): string {
	return event.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}
export function detailsFullOutputPath(details: unknown): string | undefined {
	const value = recordValue(details, "fullOutputPath");
	return typeof value === "string" ? value : undefined;
}
function exactUtf8(bytes: Buffer): string {
	const text = bytes.toString("utf8");
	if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Shell log is not valid UTF-8");
	return text;
}
async function readPiLog(path: string, shell: "bash" | "powershell", maxChars: number): Promise<string> {
	if (!isAbsolute(path)) throw new Error("Shell log path must be absolute");
	if (!new RegExp(`^pi-${shell}-[^/\\\\]+\\.log$`, "u").test(basename(path))) throw new Error("Untrusted shell log name");
	const root = await realpath(tmpdir());
	// Validate the original path with safe-files too, not only its resolved target.
	if (dirname(await realpath(path)) !== root) throw new Error("Untrusted shell log location");
	return exactUtf8(await readBoundedFile(path, maxChars * 4));
}
async function exactBody(inline: string, details: unknown, shell: "bash" | "powershell", maxChars: number): Promise<string> {
	const path = detailsFullOutputPath(details) ?? (shell === "bash" ? inline.match(/Full output:\s*([^\]\r\n]+)/u)?.[1]?.trim() : undefined);
	if (path) return readPiLog(path, shell, maxChars);
	if (recordValue(recordValue(details, "truncation"), "truncated") === true || /Full output:|\[Output truncated|\[Showing (?:last|lines)/u.test(inline)) throw new Error("Missing full shell log");
	return inline;
}

export async function reducibleToolResult(event: ToolResultEvent, sessionId?: string, maxChars = 600_000): Promise<ReducibleToolResult | undefined> {
	const structured = recordValue(event, "structuredContent");
	if (structured !== undefined && (!isRecord(structured) || !isJsonValue(structured))) return undefined;
	if (event.toolName === "bash" || event.toolName === "powershell") {
		if (structured !== undefined && (!isRecord(structured) || typeof structured.output !== "string" || typeof structured.exit_code !== "number" || typeof structured.truncated !== "boolean" || typeof structured.wall_time_seconds !== "number" || (structured.full_output_path !== undefined && typeof structured.full_output_path !== "string") || Object.keys(structured).some((key) => !["output", "exit_code", "truncated", "wall_time_seconds", "full_output_path"].includes(key)))) return undefined;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (!command) return undefined;
		const inline = textContent(event);
		const fullPath = isRecord(structured) && typeof structured.full_output_path === "string" ? structured.full_output_path : undefined;
		const body = await exactBody(inline, fullPath ? { fullOutputPath: detailsFullOutputPath(event.details) ?? fullPath } : event.details, event.toolName, maxChars);
		if (isRecord(structured) && structured.truncated && !detailsFullOutputPath(event.details) && !fullPath && !inline.includes("Full output:")) return undefined;
		return {
			command, body,
			projectReceipt: (receipt) => [{ type: "text", text: receipt }],
			...(isRecord(structured) ? { projectStructured: (receipt: string) => ({ ...structured, output: receipt }) } : {}),
		};
	}
	if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
	const artifact = takeArtifact(sessionId, event.toolCallId);
	const command = recordValue(recordValue(event.input, "then_run"), "command");
	if (typeof command !== "string" || !command) return undefined;
	const marker = event.isError ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
	for (let index = 0; index < event.content.length; index++) {
		const block = event.content[index];
		if (!block || block.type !== "text") continue;
		const markerIndex = block.text.indexOf(marker);
		if (markerIndex < 0) continue;
		const suffixStart = markerIndex + marker.length;
		const suffix = block.text.slice(suffixStart);
		const separator = suffix.match(/^(?:\r?\n)+/u)?.[0] ?? "\n";
		const inline = suffix.slice(separator === "\n" && !suffix.startsWith("\n") ? 0 : separator.length);
		let body: string;
		if (artifact) {
			if (!artifact.complete || artifact.version !== 1 || artifact.toolCallId !== event.toolCallId) return undefined;
			if (basename(artifact.path) !== "output.log" || !basename(dirname(artifact.path)).startsWith("sol-pi-pwsh-") || dirname(await realpath(dirname(artifact.path))) !== await realpath(tmpdir())) return undefined;
			const bytes = await readBoundedFile(artifact.path, maxChars * 4);
			body = exactUtf8(bytes);
			if (bytes.length !== artifact.bytes || sha256(body) !== artifact.sha256) return undefined;
		} else {
			// A PowerShell artifact is never authorized by visible text or copied details.
			if (recordValue(event.details, "actionFusionArtifact") !== undefined || inline.includes("sol-pi-pwsh-")) return undefined;
			body = await exactBody(inline, event.details, "bash", maxChars);
		}
		return {
			command, body,
			projectReceipt: (receipt) => event.content.map((content, contentIndex) => contentIndex === index && content.type === "text" ? { ...content, text: `${content.text.slice(0, suffixStart)}${separator}${receipt}` } : content),
			...(isRecord(structured) ? { projectStructured: () => structured } : {}),
		};
	}
	return undefined;
}

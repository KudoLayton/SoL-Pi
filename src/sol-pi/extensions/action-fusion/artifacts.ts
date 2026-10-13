/* SPDX-License-Identifier: MIT */
export interface CommandArtifact {
	readonly version: 1;
	readonly toolCallId: string;
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly complete: boolean;
}
const sessions = new Map<string, Map<string, CommandArtifact>>();
export function rememberArtifact(session: string, artifact: CommandArtifact): void {
	let entries = sessions.get(session);
	if (!entries) { entries = new Map(); sessions.set(session, entries); }
	entries.delete(artifact.toolCallId);
	entries.set(artifact.toolCallId, Object.freeze({ ...artifact }));
	while (entries.size > 256) entries.delete(entries.keys().next().value!);
}
export function takeArtifact(session: string | undefined, toolCallId: string): CommandArtifact | undefined {
	if (!session) return undefined;
	const entries = sessions.get(session);
	const artifact = entries?.get(toolCallId);
	entries?.delete(toolCallId);
	if (!entries?.size) sessions.delete(session);
	return artifact;
}
export function clearArtifacts(session: string): void { sessions.delete(session); }

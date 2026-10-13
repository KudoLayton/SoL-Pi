/* SPDX-License-Identifier: MIT */
import { constants, type BigIntStats } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
const changed = () => Object.assign(new Error("Stored file changed during access"), { code: "ESTALE" });
export function assertSameFile(before: BigIntStats, after: BigIntStats): void {
	if (before.dev !== after.dev || before.ino !== after.ino) throw changed();
}
export async function inspectParents(path: string): Promise<BigIntStats[]> {
	const parents: BigIntStats[] = [];
	let directory = dirname(resolve(path));
	while (true) {
		const stats = await lstat(directory, { bigint: true });
		if (stats.isSymbolicLink()) throw Object.assign(new Error("Stored file parent is not a regular directory (symbolic link)"), { code: "ELOOP" });
		if (!stats.isDirectory()) throw new Error("Stored file parent is not a regular directory");
		parents.push(stats);
		const parent = dirname(directory);
		if (parent === directory) return parents;
		directory = parent;
	}
}
async function inspectFile(path: string): Promise<BigIntStats> {
	const stats = await lstat(path, { bigint: true });
	if (stats.isSymbolicLink()) throw Object.assign(new Error("Stored file is a symbolic link"), { code: "ELOOP" });
	if (!stats.isFile()) throw new Error("Stored object is not a regular file");
	return stats;
}
export async function withStoredFile<T>(path: string, read: (handle: FileHandle) => Promise<T>): Promise<T> {
	const parents = await inspectParents(path);
	const before = await inspectFile(path);
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat({ bigint: true });
		assertSameFile(before, opened);
		assertSameFile(opened, await inspectFile(path));
		const value = await read(handle);
		const after = await handle.stat({ bigint: true });
		assertSameFile(opened, after);
		if (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) throw changed();
		assertSameFile(opened, await inspectFile(path));
		const afterParents = await inspectParents(path);
		if (parents.length !== afterParents.length) throw changed();
		parents.forEach((parent, index) => assertSameFile(parent, afterParents[index]!));
		return value;
	} finally { await handle.close(); }
}
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
	return withStoredFile(path, async (handle) => {
		const size = (await handle.stat()).size;
		if (size > maxBytes) throw new Error("Stored object exceeds size limit");
		const bytes = Buffer.alloc(size + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) break;
			offset += bytesRead;
		}
		if (offset !== size) throw changed();
		return bytes.subarray(0, size);
	});
}
/** Create each missing directory only after inspecting its existing ancestors. */
export async function ensureSafeParents(path: string): Promise<void> {
	const directory = dirname(resolve(path));
	try {
		const stats = await lstat(directory);
		if (stats.isSymbolicLink()) throw Object.assign(new Error("Stored file parent is not a regular directory (symbolic link)"), { code: "ELOOP" });
		if (!stats.isDirectory()) throw new Error("Stored file parent is not a regular directory");
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
		await ensureSafeParents(directory);
		try { await mkdir(directory, { mode: 0o700 }); }
		catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
	}
	await inspectParents(path);
}
export async function storeVerifiedFile(path: string, body: string): Promise<void> {
	await ensureSafeParents(path);
	const parents = await inspectParents(path);
	let handle: FileHandle;
	try { handle = await open(path, CREATE_OBJECT_FLAGS, 0o600); }
	catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		const existing = await readBoundedFile(path, Buffer.byteLength(body));
		if (!existing.equals(Buffer.from(body))) throw new Error("Archive integrity failure: hash mismatch");
		return;
	}
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile()) throw new Error("Stored object is not a regular file");
		assertSameFile(opened, await inspectFile(path));
		await handle.writeFile(body, "utf8");
		assertSameFile(opened, await inspectFile(path));
		const after = await inspectParents(path);
		if (parents.length !== after.length) throw changed();
		parents.forEach((parent, i) => assertSameFile(parent, after[i]!));
	} finally { await handle.close(); }
}

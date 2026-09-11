import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readRecallChunk } from "../src/sol-pi/extensions/observation-pack/observation.ts";

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return { ...fs, open: vi.fn(fs.open) };
});

const roots: string[] = [];
const limits = { maxBytes: 1024, maxLines: 20 };
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "sol-pi-file-safety-"));
	roots.push(root);
	const path = join(root, "한글 file.txt");
	await writeFile(path, "original bytes");
	return { root, path };
}
afterEach(async () => {
	vi.mocked(open).mockRestore();
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("reads regular files with Unicode and spaces in their path", async () => {
	const { path } = await fixture();
	expect((await readRecallChunk(path, 0, limits)).text).toBe("original bytes");
});

it("rejects a junction or symbolic-link ancestor", async () => {
	const { root } = await fixture();
	const target = join(root, "target");
	await mkdir(join(target, "objects"), { recursive: true });
	await writeFile(join(target, "objects", "payload.txt"), "outside bytes");
	const link = join(root, "linked");
	await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
	await expect(readRecallChunk(join(link, "objects", "payload.txt"), 0, limits)).rejects.toMatchObject({ code: "ELOOP" });
});

it("rejects directories as observations", async () => {
	const { root } = await fixture();
	await expect(readRecallChunk(root, 0, limits)).rejects.toThrow(/regular file/);
});

it("rejects replacement between inspection and opening", async () => {
	const { root, path } = await fixture();
	const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
	vi.mocked(open).mockImplementationOnce(async (...args) => {
		await rename(path, join(root, "original.txt"));
		await writeFile(path, "replacement bytes");
		return fs.open(...args);
	});
	await expect(readRecallChunk(path, 0, limits)).rejects.toMatchObject({ code: "ESTALE" });
});

/* SPDX-License-Identifier: MIT */
// Runs against disposable copies, never changes the checkout or the installed Pi.
// Usage: npm_execpath=/path/to/npm-cli.js node scripts/check-pi-matrix.mjs [versions...]
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
const versions = process.argv.slice(2);
if (!versions.length) versions.push("0.84.2", "0.85.1", "1.2.0");
if (versions.some((version) => !/^\d+\.\d+\.\d+$/.test(version))) throw new Error("Expected exact semantic versions");
const root = await mkdtemp(join(tmpdir(), "sol-pi-matrix-"));
console.log(`Validation artifacts: ${root}`);
const results = [];
for (const version of versions) {
	const cwd = join(root, version);
	await mkdir(cwd);
	for (const entry of ["src", "tests", "scripts", "docs", "assets", "package.json", "package-lock.json", "tsconfig.json", "README.md", "AGENTS.md", "CLAUDE.md", "agents-install.md", "sol-pi.example.json", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md"]) {
		await cp(join(source, entry), join(cwd, entry), { recursive: true });
	}
	const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
	const originalVersion = manifest.devDependencies["@earendil-works/pi-coding-agent"];
	// The install-guide test intentionally binds the guide to the fixture's dev version.
	const guidePath = join(cwd, "agents-install.md");
	await writeFile(guidePath, (await readFile(guidePath, "utf8")).replaceAll(originalVersion, version));
	for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"]) manifest.devDependencies[`@earendil-works/${name}`] = version;
	if (version === "1.2.0") manifest.devDependencies["@narumitw/pi-codex-compact"] = "0.56.0";
	await writeFile(join(cwd, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
	const agentDir = join(cwd, "isolated-agent");
	await mkdir(agentDir);
	const checks = [];
	for (const [name, args] of [
		["lock", [npm, "install", "--package-lock-only", "--ignore-scripts"]],
		["ci", [npm, "ci", "--ignore-scripts"]],
		["check", [npm, "run", "check"]],
		["api", ["scripts/check-pi-compat.mjs"]],
		["audit", [npm, "audit", "--audit-level=high"]],
	]) {
		const result = spawnSync(process.execPath, args, {
			cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 300_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true,
		});
		await writeFile(join(root, `${version}-${name}.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error ?? ""}`);
		checks.push({ name, status: result.status, error: result.error?.message });
		console.log(`${version} ${name}: ${result.status}`);
		if (result.status !== 0) break;
	}
	results.push({ version, cwd, checks });
}
await writeFile(join(root, "results.json"), JSON.stringify(results, null, 2));
if (results.some(({ checks }) => checks.length !== 5 || checks.some(({ status }) => status !== 0))) process.exitCode = 1;

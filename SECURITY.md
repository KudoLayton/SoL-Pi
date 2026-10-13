# Security Policy

SoL-Pi is a Pi extension. It runs with the filesystem, process, network, and credential permissions of the Pi process that loads it. SoL-Pi is not a sandbox or permission boundary.

## Sensitive behavior

- Action Fusion can modify files and run shell commands requested by the model. Opt-in native PowerShell 7 runs without a profile or execution-policy bypass, but is not sandboxed. It inherits Pi's environment. Command failures do not undo file changes.
- Native PowerShell creates temporary scripts (removed after execution) and full output logs under unique `sol-pi-pwsh-*` directories in the OS temporary directory. Logs remain after success, failure, or cancellation for evidence access and require host/caller cleanup. These may contain secrets even with EPR/OCC disabled. Use trusted user-owned temporary and session directories; POSIX mode bits do not guarantee private Windows ACLs. Forced Pi termination may also leave command scripts behind.
- ObservationPack stores large tool results under Pi's session directory.
- Evidence-Preserving Reducer archives diagnostic logs locally and, when explicitly enabled, sends eligible logs through the configured reducer model using Pi-managed authentication.
- The reducer skips text matching its likely-secret detector, but that detector is a precaution rather than a complete secret scanner. Do not enable remote reduction for workloads whose logs must remain local.
- Online Context Compact stores plan and compaction state in Pi's session log; see below.
- Project-local `.pi/sol-pi.json` files should be used only in trusted repositories.

## Online Context Compact data

Online Context Compact is off by default. When enabled, every `update_plan` call appends a versioned custom state entry to Pi's session log. The latest valid entry holds the model-authored plan, concise progress fields, request counts, token-growth estimates, and compaction debt. These values can include paths, command names, and design notes and should be treated as sensitive as the rest of the conversation. After a successful compaction, the extension also writes one hidden, generic custom message that tells the assistant to rebuild its plan; the reminder contains no task-specific data.

The extension creates no sidecar, attestation, payload-capture, or research-instrumentation files. State entries do not enter the model context; only the generic post-compaction reminder does. Deleting the Pi session removes both kinds of persisted Online Context Compact data.

Evidence-Preserving Reducer may read an overlong shell result outside its session archive. Pi-produced `pi-bash-*.log` / `pi-powershell-*.log` files must be regular files directly in the OS temporary directory, with no symbolic-link or junction ancestors. ActionFusion PowerShell logs require a matching in-process session/call reference, byte count, and hash; copied result text or metadata alone does not authorize reading them. Reads are bounded and use a single inspected handle. Incomplete or unverifiable sources are not sent for reduction. Eligible sources are copied into the session-specific archive before any nested model call. These are defenses within a trusted user-owned storage root, not an atomic sandbox against every concurrent filesystem attack.

The live compatibility harness is opt-in and separate from extension runtime. It uses synthetic inputs, a read-only credential adapter, explicit model selection and strict dispatch limits. Its limits do not establish a currency spending cap. The selected live-test model does not become the default reducer or compaction model.

## Reporting a vulnerability

Use the repository's GitHub Security Advisories page to submit a private report. Do not open a public issue for a suspected vulnerability.

Include the affected commit or version, configuration, impact, reproduction steps, and any available mitigation. Reports about Pi itself should be sent to the upstream Pi project.

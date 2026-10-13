/* SPDX-License-Identifier: MIT */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Pi 1.2 adds tool dispatch capabilities; derive the public execution context
 * instead of importing a type that does not exist in supported older releases. */
export type ToolExecutionContext = Parameters<ToolDefinition["execute"]>[4];

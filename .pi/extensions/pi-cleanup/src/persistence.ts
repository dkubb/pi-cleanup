/**
 * Session persistence helpers for the cleanup extension.
 *
 * Provides constants for entry custom types and functions to persist
 * gate configuration and clean commit SHAs. Persisted data is stored
 * as plain JSON (not branded types) and re-validated on restore.
 *
 * @module
 */

import type { AppendEntryFn, CommitSHA, GateConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Entry Type Constants
// ---------------------------------------------------------------------------

/** Custom entry type for persisted gate configuration. */
export const ENTRY_TYPE_GATES = "pi-cleanup-gates" as const;

/** Custom entry type for persisted clean commit SHA. */
export const ENTRY_TYPE_COMMIT = "pi-cleanup-commit" as const;

// ---------------------------------------------------------------------------
// Persistence Functions
// ---------------------------------------------------------------------------

/**
 * Persist the current gate configuration to the session.
 *
 * Serializes gate commands as plain strings (not branded types)
 * because `pi.appendEntry` writes JSON. The restore path (session_start
 * handler) re-validates with Schema decoders.
 *
 * @param _appendEntry - The injected appendEntry function (pi.appendEntry signature).
 * @param _config - The gate configuration to persist.
 *
 * @example
 * ```ts
 * const calls: Array<[string, unknown]> = [];
 * const mockAppend = (type: string, data: unknown) => { calls.push([type, data]); };
 * persistGateConfig(mockAppend, { commands: [gateCommand("npm test")], description: "test" });
 * assert(calls.length === 1);
 * assert(calls[0][0] === "pi-cleanup-gates");
 * ```
 */
export const persistGateConfig = (_appendEntry: AppendEntryFn, _config: GateConfig): void => {
  // What: Write gate config to the session as a custom entry.
  // Why: Gate config must survive session reloads. appendEntry persists
  //      To the session file as JSON.
  // How: appendEntry(ENTRY_TYPE_GATES, { commands: config.commands.map(String),
  //      Description: config.description })
  //      We map commands to plain strings because branded types don't
  //      Survive JSON serialization.

  // TODO: Implement
  throw new Error("Not implemented");
};

/**
 * Persist a gate-clear tombstone to the session.
 *
 * When restored, the session_start handler sees the cleared flag
 * and sets gateConfig to None, ensuring that `/gates clear` is
 * durable across session reloads.
 *
 * @param _appendEntry - The injected appendEntry function (pi.appendEntry signature).
 *
 * @example
 * ```ts
 * const calls: Array<[string, unknown]> = [];
 * const mockAppend = (type: string, data: unknown) => { calls.push([type, data]); };
 * persistGatesClear(mockAppend);
 * assert(calls.length === 1);
 * assert(calls[0][0] === "pi-cleanup-gates");
 * assert(calls[0][1].cleared === true);
 * ```
 */
export const persistGatesClear = (_appendEntry: AppendEntryFn): void => {
  // What: Write a tombstone entry that marks gates as cleared.
  // Why: Without this, `/gates clear` is ephemeral — gates reappear
  //      On session reload because the original config entry still exists.
  // How: appendEntry(ENTRY_TYPE_GATES, { cleared: true })
  //      The restore path checks for the `cleared` flag and sets
  //      GateConfig to None when found.

  // TODO: Implement
  throw new Error("Not implemented");
};

/**
 * Persist the current clean commit SHA to the session.
 *
 * Serializes the SHA as a plain string. The restore path re-validates
 * with `decodeCommitSHA`.
 *
 * @param _appendEntry - The injected appendEntry function (pi.appendEntry signature).
 * @param _sha - The clean commit SHA to persist.
 *
 * @example
 * ```ts
 * const calls: Array<[string, unknown]> = [];
 * const mockAppend = (type: string, data: unknown) => { calls.push([type, data]); };
 * persistCleanCommit(mockAppend, commitSHA("a".repeat(40)));
 * assert(calls.length === 1);
 * assert(calls[0][0] === "pi-cleanup-commit");
 * ```
 */
export const persistCleanCommit = (_appendEntry: AppendEntryFn, _sha: CommitSHA): void => {
  // What: Write clean commit SHA to the session as a custom entry.
  // Why: The last clean SHA determines the commit range for atomicity
  //      Checking across session reloads.
  // How: appendEntry(ENTRY_TYPE_COMMIT, { sha: String(sha) })

  // TODO: Implement
  throw new Error("Not implemented");
};

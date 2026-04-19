/**
 * Session state restoration helpers.
 *
 * Parses persisted session entries back into typed runtime state.
 * This is the "parse" boundary where raw JSON becomes typed data.
 *
 * @module
 */

import { Either, Option } from "effect";

import {
  type CommitSHA,
  decodeCommitSHA,
  decodeGateCommand,
  type GateCommand,
  type GateConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Gate Config Restoration
// ---------------------------------------------------------------------------

/**
 * Parse validated gate commands from raw entry data.
 *
 * Fails closed: if any element fails validation, returns None so
 * the caller treats the whole config as unusable. Silently keeping
 * the valid subset would weaken the gate set without any signal to
 * the user.
 *
 * Logs a warning on the first invalid element so a corrupted
 * persisted entry is distinguishable from an absent one in
 * extension logs — the None return alone cannot tell the caller
 * which case occurred.
 *
 * @param rawCommands - The raw commands array from persisted data.
 * @returns All validated commands, or None if any element is invalid.
 */
const parseGateCommands = (rawCommands: unknown[]): Option.Option<GateCommand[]> => {
  const commands: GateCommand[] = [];

  for (const cmd of rawCommands) {
    const decoded = decodeGateCommand(cmd);

    if (Either.isLeft(decoded)) {
      console.warn(
        `[pi-cleanup] parseGateCommands: invalid command in persisted gate entry; discarding whole entry (value=${JSON.stringify(cmd)?.slice(0, 80) ?? "undefined"})`,
      );
      return Option.none();
    }

    commands.push(decoded.right);
  }

  return Option.some(commands);
};

/**
 * Resolve a description value from raw entry data.
 *
 * @param value - The raw description value.
 * @returns The description string.
 */
const resolveDescription = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  return "Restored from session";
};

/**
 * Restore gate config from a custom entry's data.
 *
 * Handles both config entries and tombstone (cleared) entries.
 * Invalid or missing data produces None (graceful degradation).
 *
 * @param data - The raw entry data from the session.
 * @returns The restored GateConfig, or None.
 */

export const restoreGateConfig = (data: unknown): Option.Option<GateConfig> => {
  const record = data as Record<string, unknown> | undefined;

  if (record?.["cleared"] === true) {
    return Option.none();
  }

  const rawCommands = record?.["commands"];

  if (!Array.isArray(rawCommands)) {
    return Option.none();
  }

  const parsed = parseGateCommands(rawCommands);

  if (Option.isNone(parsed)) {
    return Option.none();
  }

  const [first, ...rest] = parsed.value;

  if (first === undefined) {
    return Option.none();
  }

  const description = resolveDescription(record?.["description"]);

  return Option.some({
    commands: [first, ...rest],
    description,
  });
};

// ---------------------------------------------------------------------------
// Commit SHA Restoration
// ---------------------------------------------------------------------------

/**
 * Restore a clean commit SHA from a custom entry's data.
 *
 * Returns None for all failure causes — absent record, non-string
 * `sha` field, string that fails to decode as a CommitSHA — but
 * logs a warning on the last case so a corrupted persisted entry
 * is distinguishable from a simply-absent one in extension logs.
 *
 * @param data - The raw entry data from the session.
 * @returns The restored CommitSHA, or None.
 */
export const restoreCommitSHA = (data: unknown): Option.Option<CommitSHA> => {
  const record = data as Record<string, unknown> | undefined;
  const sha = record?.["sha"];

  if (typeof sha !== "string") {
    return Option.none();
  }

  const decoded = decodeCommitSHA(sha);

  if (Either.isLeft(decoded)) {
    console.warn(
      `[pi-cleanup] restoreCommitSHA: invalid CommitSHA in persisted entry (value="${sha.slice(0, 80)}")`,
    );
    return Option.none();
  }

  return Option.some(decoded.right);
};

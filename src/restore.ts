/**
 * Session state restoration helpers.
 *
 * Parses persisted session entries back into typed runtime state.
 * This is the "parse" boundary where raw JSON becomes typed data.
 *
 * Every failure mode is represented as its own variant in a tagged
 * `RestoreError` union so callers can distinguish "absent" from
 * "corrupt" at the type level — per the state-space-minimization
 * skill, logs are a complement to types, not a substitute for them.
 *
 * @module
 */

import { Data, Either } from "effect";

import {
  type CommitSHA,
  decodeCommitSHA,
  decodeGateCommand,
  type GateCommand,
  type GateConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Reasons `restoreGateConfig` may fail to produce a GateConfig.
 *
 * Each variant names a distinct real-world outcome at the
 * persistence boundary. Callers can choose to log, ignore, or
 * escalate per-variant rather than treating every failure as the
 * same silent "absent".
 */
export type GateConfigRestoreError = Data.TaggedEnum<{
  /** Data is not a record (e.g. null, string, number, array). */
  readonly NotARecord: {};
  /** Tombstone entry — gates were explicitly cleared. */
  readonly Tombstone: {};
  /** Record present but `commands` is absent or not an array. */
  readonly CommandsNotArray: {};
  /** Commands array present but empty after parsing. */
  readonly CommandsEmpty: {};
  /** Commands array had an element that failed GateCommand validation. */
  readonly InvalidCommand: { readonly raw: unknown };
}>;

/** Constructor namespace for {@link GateConfigRestoreError} variants. */
export const GateConfigRestoreError = Data.taggedEnum<GateConfigRestoreError>();

/**
 * Reasons `restoreCommitSHA` may fail to produce a CommitSHA.
 */
export type CommitSHARestoreError = Data.TaggedEnum<{
  /** Data is not a record, or `sha` field is missing / not a string. */
  readonly NotAString: {};
  /** `sha` field present but failed CommitSHA schema validation. */
  readonly InvalidSHA: { readonly raw: string };
}>;

/** Constructor namespace for {@link CommitSHARestoreError} variants. */
export const CommitSHARestoreError = Data.taggedEnum<CommitSHARestoreError>();

// ---------------------------------------------------------------------------
// Gate Config Restoration
// ---------------------------------------------------------------------------

/**
 * Parse validated gate commands from a raw commands array.
 *
 * Fails closed on the first invalid element so a corrupted entry
 * does not weaken the gate set to a strict subset of what the user
 * configured.
 *
 * @param rawCommands - The raw commands array from persisted data.
 * @returns Right with all validated commands, or Left with the first
 *   invalid raw value encountered.
 */
const parseGateCommands = (
  rawCommands: unknown[],
): Either.Either<GateCommand[], GateConfigRestoreError> => {
  const commands: GateCommand[] = [];

  for (const cmd of rawCommands) {
    const decoded = decodeGateCommand(cmd);

    if (Either.isLeft(decoded)) {
      return Either.left(GateConfigRestoreError.InvalidCommand({ raw: cmd }));
    }

    commands.push(decoded.right);
  }

  return Either.right(commands);
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
 * Check that `data` is a non-null, non-array plain object.
 *
 * @param data - The raw entry data to validate.
 * @param onNotARecord - Builds the caller-specific error for non-record data.
 * @returns Right(record) if data is a record; Left(NotARecord) otherwise.
 */
const asRecord = <E>(
  data: unknown,
  onNotARecord: () => E,
): Either.Either<Record<string, unknown>, E> => {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return Either.left(onNotARecord());
  }
  return Either.right(data as Record<string, unknown>);
};

/**
 * Extract and validate the `commands` array from a record.
 *
 * @param record - The persisted entry as a plain object.
 * @returns Right(rawCommands) if present and an array; Left otherwise.
 */
const asCommandsArray = (
  record: Record<string, unknown>,
): Either.Either<unknown[], GateConfigRestoreError> => {
  if (record["cleared"] === true) {
    return Either.left(GateConfigRestoreError.Tombstone());
  }

  const rawCommands = record["commands"];

  if (!Array.isArray(rawCommands)) {
    return Either.left(GateConfigRestoreError.CommandsNotArray());
  }

  return Either.right(rawCommands);
};

const asNonEmptyCommands = (
  commands: GateCommand[],
): Either.Either<readonly [GateCommand, ...GateCommand[]], GateConfigRestoreError> => {
  const [first, ...rest] = commands;

  if (first === undefined) {
    return Either.left(GateConfigRestoreError.CommandsEmpty());
  }

  return Either.right([first, ...rest]);
};

const resolveGateConfigDescription = (record: Record<string, unknown>): string => {
  const { description } = record;

  return resolveDescription(description);
};

const buildGateConfig = (
  commands: readonly [GateCommand, ...GateCommand[]],
  record: Record<string, unknown>,
): GateConfig => ({ commands, description: resolveGateConfigDescription(record) });

/**
 * Restore gate config from a custom entry's data.
 *
 * @param data - The raw entry data from the session.
 * @returns Right(GateConfig) on success; Left(GateConfigRestoreError)
 *   naming the specific failure mode.
 */
export const restoreGateConfig = (
  data: unknown,
): Either.Either<GateConfig, GateConfigRestoreError> => {
  const recordResult = asRecord(data, () => GateConfigRestoreError.NotARecord());

  if (Either.isLeft(recordResult)) {
    return Either.left(recordResult.left);
  }

  const commandsArrayResult = asCommandsArray(recordResult.right);

  if (Either.isLeft(commandsArrayResult)) {
    return Either.left(commandsArrayResult.left);
  }

  const commandsResult = parseGateCommands(commandsArrayResult.right);

  if (Either.isLeft(commandsResult)) {
    return Either.left(commandsResult.left);
  }

  const nonEmptyCommandsResult = asNonEmptyCommands(commandsResult.right);

  if (Either.isLeft(nonEmptyCommandsResult)) {
    return Either.left(nonEmptyCommandsResult.left);
  }

  return Either.right(buildGateConfig(nonEmptyCommandsResult.right, recordResult.right));
};

// ---------------------------------------------------------------------------
// Commit SHA Restoration
// ---------------------------------------------------------------------------

/**
 * Restore a clean commit SHA from a custom entry's data.
 *
 * @param data - The raw entry data from the session.
 * @returns Right(CommitSHA) on success; Left(CommitSHARestoreError)
 *   naming the specific failure mode.
 */
export const restoreCommitSHA = (data: unknown): Either.Either<CommitSHA, CommitSHARestoreError> =>
  Either.flatMap(
    asRecord<CommitSHARestoreError>(data, () => CommitSHARestoreError.NotAString()),
    (record): Either.Either<CommitSHA, CommitSHARestoreError> => {
      const { sha } = record;

      if (typeof sha !== "string") {
        return Either.left(CommitSHARestoreError.NotAString());
      }

      const decoded = decodeCommitSHA(sha);

      if (Either.isLeft(decoded)) {
        return Either.left(CommitSHARestoreError.InvalidSHA({ raw: sha }));
      }

      return Either.right(decoded.right);
    },
  );

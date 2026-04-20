/**
 * Branded primitive types and compound types for the cleanup extension.
 *
 * Uses Effect Schema + Brand for "Parse, Don't Validate". Constructors
 * that narrow input return `Either<BrandedType, ParseError>`. Once a
 * value has a branded type, downstream code trusts it without
 * re-validation.
 *
 * @module
 */

import type {
  ExecOptions,
  ExecResult,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Data, Schema, type Either, type ParseResult } from "effect";

// ---------------------------------------------------------------------------
// Branded Primitives
// ---------------------------------------------------------------------------

/**
 * A git commit SHA — exactly 40 lowercase hexadecimal characters.
 *
 * @example
 * ```ts
 * import { Either } from "effect";
 *
 * // Valid: 40 lowercase hex chars
 * const valid = decodeCommitSHA("a]".repeat(20));
 * assert(Either.isRight(valid));
 *
 * // Invalid: uppercase hex
 * const upper = decodeCommitSHA("A".repeat(40));
 * assert(Either.isLeft(upper));
 *
 * // Invalid: wrong length
 * const short = decodeCommitSHA("abcdef");
 * assert(Either.isLeft(short));
 *
 * // Invalid: non-hex characters
 * const nonHex = decodeCommitSHA("g".repeat(40));
 * assert(Either.isLeft(nonHex));
 * ```
 */
export const CommitSHA = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{40}$/),
  Schema.brand("CommitSHA"),
);

/** A validated 40-character lowercase hex git commit SHA. */
export type CommitSHA = typeof CommitSHA.Type;

/**
 * Parse an unknown value into a CommitSHA.
 *
 * Returns `Right<CommitSHA>` for valid 40-char lowercase hex strings,
 * `Left<ParseError>` for everything else.
 */
export const decodeCommitSHA = Schema.decodeUnknownEither(CommitSHA);

/**
 * A non-empty shell command string with no leading/trailing whitespace.
 *
 * @example
 * ```ts
 * import { Either } from "effect";
 *
 * // Valid: non-empty trimmed string
 * const valid = decodeGateCommand("echo ok");
 * assert(Either.isRight(valid));
 *
 * // Invalid: empty string
 * const empty = decodeGateCommand("");
 * assert(Either.isLeft(empty));
 *
 * // Invalid: whitespace-only
 * const spaces = decodeGateCommand("   ");
 * assert(Either.isLeft(spaces));
 * ```
 */
export const GateCommand = Schema.NonEmptyTrimmedString.pipe(Schema.brand("GateCommand"));

/** A validated non-empty trimmed shell command string. */
export type GateCommand = typeof GateCommand.Type;

/**
 * Parse an unknown value into a GateCommand.
 *
 * Returns `Right<GateCommand>` for non-empty trimmed strings,
 * `Left<ParseError>` for empty or whitespace-only strings.
 */
export const decodeGateCommand = Schema.decodeUnknownEither(GateCommand);

/**
 * A non-negative integer representing a cleanup attempt count.
 *
 * @example
 * ```ts
 * import { Either } from "effect";
 *
 * // Valid: zero
 * const zero = decodeAttemptCount(0);
 * assert(Either.isRight(zero));
 *
 * // Valid: positive integer
 * const three = decodeAttemptCount(3);
 * assert(Either.isRight(three));
 *
 * // Invalid: negative
 * const neg = decodeAttemptCount(-1);
 * assert(Either.isLeft(neg));
 *
 * // Invalid: non-integer
 * const frac = decodeAttemptCount(1.5);
 * assert(Either.isLeft(frac));
 * ```
 */
export const AttemptCount = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
  Schema.brand("AttemptCount"),
);

/** A validated non-negative integer attempt count. */
export type AttemptCount = typeof AttemptCount.Type;

/**
 * Parse an unknown value into an AttemptCount.
 *
 * Returns `Right<AttemptCount>` for non-negative integers,
 * `Left<ParseError>` for negative numbers or non-integers.
 */
export const decodeAttemptCount = Schema.decodeUnknownEither(AttemptCount);

/**
 * A non-negative integer commit count parsed from git stdout.
 *
 * @example
 * ```ts
 * import { Either } from "effect";
 *
 * // Valid: zero commits
 * const zero = decodeCommitCount("0");
 * assert(Either.isRight(zero));
 *
 * // Valid: multiple commits
 * const fortyTwo = decodeCommitCount("42");
 * assert(Either.isRight(fortyTwo));
 *
 * // Invalid: negative
 * const neg = decodeCommitCount("-1");
 * assert(Either.isLeft(neg));
 *
 * // Invalid: non-integer
 * const frac = decodeCommitCount("1.5");
 * assert(Either.isLeft(frac));
 * ```
 */
export const CommitCount = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9]\d*)$/),
  Schema.parseNumber,
  Schema.int(),
  Schema.nonNegative(),
  Schema.brand("CommitCount"),
);

/** A validated non-negative integer commit count. */
export type CommitCount = typeof CommitCount.Type;

/**
 * Parse an unknown value into a CommitCount.
 *
 * Returns `Right<CommitCount>` for canonical non-negative integer strings,
 * `Left<ParseError>` for negatives, floats, leading-zero strings,
 * whitespace-padded strings, and non-numeric values.
 */
export const decodeCommitCount: (
  input: unknown,
) => Either.Either<CommitCount, ParseResult.ParseError> = Schema.decodeUnknownEither(CommitCount);

/**
 * Increment an AttemptCount by one.
 *
 * This is a non-narrowing operation — adding 1 to a valid AttemptCount
 * always produces a valid AttemptCount — so it returns the value
 * directly rather than an Either.
 *
 * @param count - The current attempt count to increment.
 * @returns The next attempt count (count + 1).
 *
 * @example
 * ```ts
 * import { Either } from "effect";
 *
 * const two = Either.getOrThrow(decodeAttemptCount(2));
 * const three = incrementAttempt(two);
 * assert(three === 3);
 * ```
 */
export const incrementAttempt = (count: AttemptCount): AttemptCount =>
  Schema.decodeUnknownSync(AttemptCount)(count + 1);

/**
 * Dependency injection type for `pi.exec`.
 *
 * Matches the `ExtensionAPI.exec` signature so phase functions can
 * be tested without a full ExtensionAPI mock.
 */
export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/**
 * Dependency injection type for `pi.appendEntry`.
 *
 * Matches the `ExtensionAPI.appendEntry` signature so persistence
 * functions can be tested without a full ExtensionAPI mock.
 */
export type AppendEntryFn = <T = unknown>(customType: string, data?: T) => void;

// ---------------------------------------------------------------------------
// Cleanup Phase
// ---------------------------------------------------------------------------

/** The actionable waiting states that can stall. */
export type WaitingPhase = "WaitingForTreeFix" | "WaitingForGateFix" | "WaitingForFactoring";

// ---------------------------------------------------------------------------
// Compound Types
// ---------------------------------------------------------------------------

/**
 * Configuration for quality gate commands.
 *
 * Each command is a shell command run via `bash -c`. Commands execute
 * sequentially; the pipeline stops at the first failure.
 */
export interface GateConfig {
  /** Ordered non-empty list of shell commands to execute as quality gates. */
  readonly commands: readonly [GateCommand, ...GateCommand[]];
  /** Human-readable description of this gate configuration. */
  readonly description: string;
}

/**
 * Reason the cleanup extension is awaiting user input.
 *
 * Used as the payload of the `AwaitingUserInput` cleanup state to
 * distinguish why the extension is blocked and what action unblocks it.
 *
 * - `GatesUnconfigured`: No gate commands are set. Run `/gates` to configure.
 * - `Stalled`: Cleanup exceeded the maximum retry attempts. Run `/cleanup resume`.
 */
export type AwaitingReason = Data.TaggedEnum<{
  /** No gate commands configured. Unblock with `/gates`. */
  readonly GatesUnconfigured: {};
  /** Exceeded maximum retry attempts. Unblock with `/cleanup resume`. */
  readonly Stalled: {
    /** The waiting state that was active when the stall occurred. */
    readonly phase: WaitingPhase;
    /** The attempt count when the stall occurred. */
    readonly attempts: AttemptCount;
  };
}>;

/** Constructor namespace for {@link AwaitingReason} variants. */
export const AwaitingReason = Data.taggedEnum<AwaitingReason>();

// ---------------------------------------------------------------------------
// Command Context Reference
// ---------------------------------------------------------------------------

/**
 * Subset of ExtensionCommandContext needed for collapse.
 *
 * Stored in RuntimeState so the `agent_end` handler can call
 * `navigateTree` without requiring a full command context.
 */
export interface CommandContextRef {
  /** Navigate to a point in the session tree, collapsing in between. */
  readonly navigateTree: ExtensionCommandContext["navigateTree"];
}

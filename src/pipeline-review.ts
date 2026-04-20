/**
 * Code review pipeline phase.
 *
 * Manages the review lifecycle: validates the commit range,
 * counts commits, and delegates review to a subagent.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Either, Option } from "effect";

import { warn } from "./logger.js";
import { buildReviewMessage } from "./phases/review.js";
import type { RuntimeState } from "./runtime.js";
import type { CommitSHA } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for the code review phase. */
interface ReviewPhaseContext {
  readonly pi: ExtensionAPI;
  readonly runtime: RuntimeState;
  readonly ctx: ExtensionContext;
}

/** Input for the review phase. */
export interface ReviewInput {
  readonly phaseCtx: ReviewPhaseContext;
  readonly headEither: Either.Either<CommitSHA, unknown>;
  readonly baseSHA: Option.Option<CommitSHA>;
  readonly commitCount: Option.Option<number>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if review input represents a valid reviewable range.
 *
 * @param input - The review input to validate.
 * @returns True if the range is valid for review.
 */
const hasReviewableRange = (input: ReviewInput): boolean =>
  !input.phaseCtx.runtime.reviewComplete &&
  Either.isRight(input.headEither) &&
  Option.isSome(input.baseSHA) &&
  Option.isSome(input.commitCount) &&
  String(input.headEither.right) !== String(input.baseSHA.value);

// ---------------------------------------------------------------------------
// Commit Count
// ---------------------------------------------------------------------------

/**
 * Count commits in a range.
 *
 * Returns None when a count cannot be determined:
 * - the range endpoints aren't both known (HEAD parse failure or no base);
 * - rev-list output doesn't parse as a non-negative integer.
 *
 * All three causes are distinct real-world outcomes but they share the
 * same consequence for the caller: there is no reliable count to base a
 * review request on, so the review phase is skipped.
 *
 * @param pi - The extension API for exec.
 * @param headEither - The parsed HEAD SHA.
 * @param baseSHA - The base SHA.
 * @returns Some(count) when rev-list produced a valid non-negative
 *   integer; None otherwise.
 */
export const getCommitCount = async (
  pi: ExtensionAPI,
  headEither: Either.Either<CommitSHA, unknown>,
  baseSHA: Option.Option<CommitSHA>,
): Promise<Option.Option<number>> => {
  if (!Either.isRight(headEither) || Option.isNone(baseSHA)) {
    return Option.none();
  }

  const result = await pi.exec("git", [
    "rev-list",
    "--count",
    `${String(baseSHA.value)}..${String(headEither.right)}`,
  ]);

  const count = Number.parseInt(result.stdout.trim(), 10);

  if (Number.isNaN(count)) {
    warn(
      "getCommitCount",
      `failed to parse rev-list count (exit=${String(result.code)}, stdout="${result.stdout.slice(0, 80)}")`,
    );
    return Option.none();
  }

  return Option.some(count);
};

// ---------------------------------------------------------------------------
// Review Phase
// ---------------------------------------------------------------------------

/**
 * Run code review if not yet complete.
 *
 * First pass sends review request; second pass marks complete.
 *
 * @param input - The review input.
 * @returns True if the phase needs agent action.
 */
export const runReviewIfNeeded = (input: ReviewInput): boolean => {
  const { phaseCtx, baseSHA, headEither, commitCount } = input;
  const { pi, runtime } = phaseCtx;

  if (!hasReviewableRange(input)) {
    return false;
  }

  if (runtime.reviewPending) {
    runtime.reviewPending = false;
    runtime.reviewComplete = true;
    runtime.cycleActions.push("Delegated code review to subagent");

    return false;
  }

  // Narrow defensively. HasReviewableRange already proved these are
  // Some/Right/Some, but the types are the broader Option/Either, so
  // A future guard edit cannot silently drift past the old casts.
  if (Option.isNone(baseSHA) || Either.isLeft(headEither) || Option.isNone(commitCount)) {
    return false;
  }

  runtime.reviewPending = true;
  pi.sendUserMessage(buildReviewMessage(baseSHA.value, headEither.right, commitCount.value));

  return true;
};

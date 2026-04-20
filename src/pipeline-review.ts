/**
 * Code review pipeline phase.
 *
 * Manages the review lifecycle: validates the commit range,
 * counts commits, and delegates review to a subagent.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Data, Either, Option } from "effect";

import { warn } from "./logger.js";
import { buildReviewMessage } from "./phases/review.js";
import type { RuntimeState } from "./runtime.js";
import { decodeCommitCount, type CommitCount, type CommitSHA } from "./types.js";

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
  readonly commitCount: Option.Option<CommitCount>;
}

/** Reasons the review phase may skip work this cycle. */
export type ReviewSkipReason = Data.TaggedEnum<{
  readonly AlreadyComplete: {};
  readonly HeadUnavailable: {};
  readonly BaseUnavailable: {};
  readonly CommitCountUnavailable: {};
  readonly EmptyRange: {};
}>;

/** Constructor namespace for {@link ReviewSkipReason} variants. */
export const ReviewSkipReason = Data.taggedEnum<ReviewSkipReason>();

/** Outcome of running the review phase for this cycle. */
export type ReviewPhaseOutcome = Data.TaggedEnum<{
  readonly Requested: {};
  readonly Completed: {};
  readonly Skipped: { readonly reason: ReviewSkipReason };
}>;

/** Constructor namespace for {@link ReviewPhaseOutcome} variants. */
export const ReviewPhaseOutcome = Data.taggedEnum<ReviewPhaseOutcome>();

/** Validated reviewable commit range. */
interface ReviewableRange {
  readonly baseSHA: CommitSHA;
  readonly headSHA: CommitSHA;
  readonly commitCount: CommitCount;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse review inputs into a validated reviewable range.
 *
 * @param input - The raw review-phase input.
 * @returns Right with a validated range, or Left with the exact reason
 *   the phase should skip this cycle.
 */
const getReviewableRange = (
  input: ReviewInput,
): Either.Either<ReviewableRange, ReviewSkipReason> => {
  if (input.phaseCtx.runtime.reviewComplete) {
    return Either.left(ReviewSkipReason.AlreadyComplete());
  }

  if (Either.isLeft(input.headEither)) {
    return Either.left(ReviewSkipReason.HeadUnavailable());
  }

  if (Option.isNone(input.baseSHA)) {
    return Either.left(ReviewSkipReason.BaseUnavailable());
  }

  if (Option.isNone(input.commitCount)) {
    return Either.left(ReviewSkipReason.CommitCountUnavailable());
  }

  if (String(input.headEither.right) === String(input.baseSHA.value)) {
    return Either.left(ReviewSkipReason.EmptyRange());
  }

  return Either.right({
    baseSHA: input.baseSHA.value,
    commitCount: input.commitCount.value,
    headSHA: input.headEither.right,
  });
};

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
): Promise<Option.Option<CommitCount>> => {
  if (!Either.isRight(headEither) || Option.isNone(baseSHA)) {
    return Option.none();
  }

  const result = await pi.exec("git", [
    "rev-list",
    "--count",
    `${String(baseSHA.value)}..${String(headEither.right)}`,
  ]);

  const countEither = decodeCommitCount(result.stdout.trim());

  if (Either.isLeft(countEither)) {
    warn(
      "getCommitCount",
      `failed to parse rev-list count (exit=${String(result.code)}, stdout="${result.stdout.slice(0, 80)}")`,
    );
    return Option.none();
  }

  return Option.some(countEither.right);
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
 * @returns A tagged outcome naming whether review was requested,
 *   completed, or skipped this cycle.
 */
export const runReviewIfNeeded = (input: ReviewInput): ReviewPhaseOutcome => {
  const { phaseCtx } = input;
  const { pi, runtime } = phaseCtx;

  if (runtime.reviewPending) {
    runtime.reviewPending = false;
    runtime.reviewComplete = true;
    runtime.cycleActions.push("Delegated code review to subagent");

    return ReviewPhaseOutcome.Completed();
  }

  const reviewableRange = getReviewableRange(input);

  if (Either.isLeft(reviewableRange)) {
    return ReviewPhaseOutcome.Skipped({ reason: reviewableRange.left });
  }

  runtime.reviewPending = true;
  pi.sendUserMessage(
    buildReviewMessage(
      reviewableRange.right.baseSHA,
      reviewableRange.right.headSHA,
      Number(reviewableRange.right.commitCount),
    ),
  );

  return ReviewPhaseOutcome.Requested();
};

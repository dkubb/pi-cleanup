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

import { captureCollapseAnchor } from "./pipeline-phases.js";
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
  readonly commitCount: number;
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
  String(input.headEither.right) !== String(input.baseSHA.value);

// ---------------------------------------------------------------------------
// Commit Count
// ---------------------------------------------------------------------------

/**
 * Count commits in a range.
 *
 * @param pi - The extension API for exec.
 * @param headEither - The parsed HEAD SHA.
 * @param baseSHA - The base SHA.
 * @returns The number of commits, or 0 if indeterminate.
 */
export const getCommitCount = async (
  pi: ExtensionAPI,
  headEither: Either.Either<CommitSHA, unknown>,
  baseSHA: Option.Option<CommitSHA>,
): Promise<number> => {
  if (!Either.isRight(headEither) || Option.isNone(baseSHA)) {
    return 0;
  }

  const result = await pi.exec("git", [
    "rev-list",
    "--count",
    `${String(baseSHA.value)}..${String(headEither.right)}`,
  ]);

  const count = Number.parseInt(result.stdout.trim(), 10);

  if (Number.isNaN(count)) {
    return 0;
  }

  return count;
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
  const { phaseCtx, baseSHA, commitCount } = input;
  const { pi, runtime, ctx } = phaseCtx;

  if (!hasReviewableRange(input)) {
    return false;
  }

  if (runtime.reviewPending) {
    runtime.reviewPending = false;
    runtime.reviewComplete = true;

    return false;
  }

  runtime.reviewPending = true;
  runtime.cycleActions.push("Delegated code review to subagent");
  captureCollapseAnchor(runtime, ctx);
  const base = (baseSHA as Option.Some<CommitSHA>).value;
  const head = Either.getOrThrow(input.headEither as Either.Either<CommitSHA>);
  pi.sendUserMessage(buildReviewMessage(base, head, commitCount));

  return true;
};

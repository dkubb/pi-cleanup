/**
 * Cleanup pipeline orchestrator.
 *
 * Wires the phase runners (gates → dirty tree → atomicity → eval)
 * into the `agent_end` handler with guard checks, attempt limiting,
 * and navigateTree collapse.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Either, Match, Option, Schema } from "effect";

import {
  captureCollapseAnchor,
  checkConvergence,
  collapseIfNeeded,
  runAtomicityPhase,
  runDirtyTreePhase,
  runGatePhase,
} from "./pipeline-phases.js";
import { isGitRepo } from "./phases/dirty-tree.js";
import { isGitUnchanged } from "./phases/git-status.js";
import { buildReviewMessage } from "./phases/review.js";
import type { RuntimeState } from "./runtime.js";
import { type CleanupState, TransitionEvent, isActionable, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";
import {
  AttemptCount as AttemptCountSchema,
  type AttemptCount,
  type CommitSHA,
  decodeCommitSHA,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum cleanup attempts before stalling. */
const MAX_ATTEMPTS = 5;

/** Decode 0 as an AttemptCount. */
const ZERO_ATTEMPTS: AttemptCount = Schema.decodeUnknownSync(AttemptCountSchema)(0);

/** The eval prompt sent after all phases pass. */
const EVAL_MESSAGE = [
  "All quality gates pass, changes are committed, and commits are atomic.",
  "",
  "Before we finish, please verify your work is complete:",
  "- Is there anything from the original task that is still pending?",
  "- Have you verified that everything you changed works as expected?",
  "",
  "Run any checks or tests needed to confirm, then make any final",
  "changes. If everything is done, just confirm.",
].join("\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the attempt count from the current cleanup state.
 *
 * Returns 0 for Idle and non-actionable states, or the stored
 * attempt count for WaitingFor* states.
 *
 * @param state - The current cleanup state.
 * @returns The attempt count for the current state.
 */
const getAttempts = (state: CleanupState): AttemptCount =>
  Match.value(state).pipe(
    Match.tag("Idle", () => ZERO_ATTEMPTS),
    Match.tag("WaitingForTreeFix", (s) => s.attempts),
    Match.tag("WaitingForGateFix", (s) => s.attempts),
    Match.tag("WaitingForFactoring", (s) => s.attempts),
    Match.orElse(() => ZERO_ATTEMPTS),
  );

/**
 * Check whether the pipeline should be skipped entirely.
 *
 * Skips when the state machine is not actionable (Disabled or
 * AwaitingUserInput), when no file-mutating tools have run since
 * the last completed cycle, or when the cycle is already complete.
 *
 * @param runtime - The runtime state to check.
 * @returns True if the pipeline should not run.
 */
const shouldSkip = (runtime: RuntimeState): boolean =>
  !isActionable(runtime.cleanup) || runtime.cycleComplete || !runtime.mutationDetected;

/**
 * Check whether the attempt limit has been exceeded.
 *
 * If exceeded, transitions to AwaitingUserInput(Stalled) and
 * notifies the user. Returns true so the caller can bail out.
 *
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context for notifications.
 * @returns True if the limit was exceeded and the handler should return.
 */
const checkMaxAttempts = (runtime: RuntimeState, ctx: ExtensionContext): boolean => {
  if (getAttempts(runtime.cleanup) < MAX_ATTEMPTS) {
    return false;
  }

  runtime.cleanup = transition(runtime.cleanup, TransitionEvent.MaxAttemptsExceeded());
  updateStatus(ctx, runtime.cleanup);
  ctx.ui.notify(
    "Cleanup stalled after too many attempts. Use /cleanup resume to retry.",
    "warning",
  );

  return true;
};

/**
 * First pass sends eval prompt; second pass collapses via navigateTree.
 *
 * @param pi - The extension API.
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context.
 */
const runEvalOrComplete = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<void> => {
  if (!runtime.evalPending) {
    runtime.evalPending = true;
    captureCollapseAnchor(runtime, ctx);
    pi.sendUserMessage(EVAL_MESSAGE);

    return;
  }

  runtime.evalPending = false;
  runtime.cycleComplete = true;
  runtime.mutationDetected = false;
  runtime.cycleActions.push("Verified task completion");
  await collapseIfNeeded(runtime);
};

/** Context for the code review phase. */
interface ReviewPhaseContext {
  readonly pi: ExtensionAPI;
  readonly runtime: RuntimeState;
  readonly ctx: ExtensionContext;
}

/**
 * Run code review if not yet complete. First pass sends review
 * request; second pass marks complete.
 *
 * @param phaseCtx - The review phase context.
 * @param headEither - The parsed HEAD SHA result.
 * @param baseSHA - The base SHA for the review range.
 * @returns True if the phase needs agent action.
 */
export const runReviewIfNeeded = (
  phaseCtx: ReviewPhaseContext,
  headEither: Either.Either<CommitSHA, unknown>,
  baseSHA: Option.Option<CommitSHA>,
): boolean => {
  const { pi, runtime, ctx } = phaseCtx;

  const hasValidRange =
    !runtime.reviewComplete &&
    Either.isRight(headEither) &&
    Option.isSome(baseSHA) &&
    String(headEither.right) !== String(baseSHA.value);

  if (!hasValidRange) {
    return false;
  }

  if (!runtime.reviewPending) {
    runtime.reviewPending = true;
    runtime.cycleActions.push("Delegated code review to subagent");
    captureCollapseAnchor(runtime, ctx);
    const base = (baseSHA as Option.Some<CommitSHA>).value;
    const head = Either.getOrThrow(headEither as Either.Either<CommitSHA>);
    pi.sendUserMessage(buildReviewMessage(base, head));

    return true;
  }

  runtime.reviewPending = false;
  runtime.reviewComplete = true;

  return false;
};

/**
 * Capture HEAD as the cycle base SHA on first pipeline entry.
 *
 * @param pi - The extension API for exec.
 * @param runtime - The mutable runtime state.
 */
const captureCycleBase = async (pi: ExtensionAPI, runtime: RuntimeState): Promise<void> => {
  if (Option.isSome(runtime.cycleBaseSHA)) {
    return;
  }

  const headResult = await pi.exec("git", ["rev-parse", "HEAD"]);
  const headEither = decodeCommitSHA(headResult.stdout.trim());

  if (Either.isRight(headEither)) {
    runtime.cycleBaseSHA = Option.some(headEither.right);
  }
};

/**
 * Run git-dependent phases: dirty tree + review + atomicity.
 *
 * @param pi - The extension API.
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context.
 * @returns True if a phase needs agent action.
 */
const runGitPhases = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<boolean> => {
  if (!(await isGitRepo(pi.exec.bind(pi)))) {
    return false;
  }

  await captureCycleBase(pi, runtime);

  if (await runDirtyTreePhase(pi, runtime, ctx)) {
    return true;
  }

  // Code review runs after tree is clean, before atomicity
  const headResult = await pi.exec("git", ["rev-parse", "HEAD"]);
  const headEither = decodeCommitSHA(headResult.stdout.trim());
  const baseSHA = Option.orElse(runtime.cycleBaseSHA, () => runtime.lastCleanCommitSHA);

  if (runReviewIfNeeded({ ctx, pi, runtime }, headEither, baseSHA)) {
    return true;
  }

  const gateConfig = Option.getOrThrow(runtime.gateConfig);

  if (!(await runAtomicityPhase({ baseSHA, ctx, gateConfig, pi, runtime }))) {
    return true;
  }

  return false;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle the `agent_end` event: run the full cleanup pipeline.
 *
 * Pipeline order: gates → dirty tree → atomicity → eval → collapse.
 * Each phase returns early if it needs agent action (fix, commit,
 * factor). The handler re-runs on the next `agent_end`.
 *
 * @param pi - The extension API for exec, messaging, and persistence.
 * @param runtime - The mutable runtime state shared across calls.
 * @param ctx - The extension context for UI and session access.
 */
export const handleAgentEnd = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<void> => {
  if (shouldSkip(runtime) || checkMaxAttempts(runtime, ctx)) {
    return;
  }

  if (await isGitUnchanged(pi.exec.bind(pi), runtime.lastCleanCommitSHA)) {
    runtime.mutationDetected = false;

    return;
  }

  if (await checkConvergence(pi, runtime, ctx)) {
    return;
  }

  // Gates always run (not git-dependent)
  if (await runGatePhase(pi, runtime, ctx)) {
    return;
  }

  // Git-dependent phases: dirty tree + atomicity (skipped outside a repo)
  if (await runGitPhases(pi, runtime, ctx)) {
    return;
  }

  await runEvalOrComplete(pi, runtime, ctx);
};

/**
 * Cleanup pipeline orchestrator.
 *
 * Wires the phase runners (gates → dirty tree → review →
 * atomicity → eval) into the `agent_end` handler with guard
 * checks, attempt limiting, and navigateTree collapse.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Match, Option, Schema } from "effect";

import {
  captureCollapseAnchor,
  checkConvergence,
  runAtomicityPhase,
  runDirtyTreePhase,
  runGatePhase,
} from "./pipeline-phases.js";
import { isGitRepo } from "./phases/dirty-tree.js";
import { isGitUnchanged, resolveBaseSHA } from "./phases/git-status.js";
import { getCommitCount, runReviewIfNeeded } from "./pipeline-review.js";
import type { RuntimeState } from "./runtime.js";
import { type CleanupState, TransitionEvent, isActionable, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";
import { AttemptCount as AttemptCountSchema, type AttemptCount, decodeCommitSHA } from "./types.js";

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
 * Whether a cleanup cycle is mid-progress (awaiting review or eval).
 *
 * @param runtime - The runtime state to check.
 * @returns True if a cycle phase is pending.
 */
export const isCycleInProgress = (runtime: RuntimeState): boolean =>
  runtime.reviewPending || runtime.evalPending;

/**
 * Check whether the pipeline should be skipped entirely.
 *
 * Allows mid-cycle continuation even without new mutations.
 *
 * @param runtime - The runtime state to check.
 * @returns True if the pipeline should not run.
 */
const shouldSkip = (runtime: RuntimeState): boolean =>
  !isActionable(runtime.cleanup) ||
  runtime.cycleComplete ||
  (!runtime.mutationDetected && !isCycleInProgress(runtime));

/**
 * Check whether the attempt limit has been exceeded.
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
  pi.sendUserMessage("/cleanup collapse", { deliverAs: "followUp" });
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

  if (await runDirtyTreePhase(pi, runtime, ctx)) {
    return true;
  }

  const headResult = await pi.exec("git", ["rev-parse", "HEAD"]);
  const headEither = decodeCommitSHA(headResult.stdout.trim());
  const baseSHA = await resolveBaseSHA(pi.exec.bind(pi), runtime.lastCleanCommitSHA);
  const commitCount = await getCommitCount(pi, headEither, baseSHA);

  if (runReviewIfNeeded({ baseSHA, commitCount, headEither, phaseCtx: { ctx, pi, runtime } })) {
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
 * Pipeline: gates → dirty tree → review → atomicity → eval → collapse.
 *
 * @param pi - The extension API.
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context.
 */
export const handleAgentEnd = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<void> => {
  if (shouldSkip(runtime) || checkMaxAttempts(runtime, ctx)) {
    return;
  }

  if (
    !isCycleInProgress(runtime) &&
    (await isGitUnchanged(pi.exec.bind(pi), runtime.lastCleanCommitSHA))
  ) {
    runtime.mutationDetected = false;

    return;
  }

  if (await checkConvergence(pi, runtime, ctx)) {
    return;
  }

  if (await runGatePhase(pi, runtime, ctx)) {
    return;
  }

  if (await runGitPhases(pi, runtime, ctx)) {
    return;
  }

  await runEvalOrComplete(pi, runtime, ctx);
};

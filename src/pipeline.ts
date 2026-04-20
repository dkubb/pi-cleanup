/**
 * Cleanup pipeline orchestrator.
 *
 * Wires the phase runners (gates → dirty tree → review →
 * atomicity → eval) into the `agent_end` handler with guard
 * checks, attempt limiting, and navigateTree collapse.
 *
 * @module
 */

// Keep direct phase imports after deleting the dead git-helpers barrel.
// This orchestrator intentionally exceeds the default dependency cap by one.
/* oxlint-disable import/max-dependencies */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Either, Match, Option, Schema } from "effect";

import { warn } from "./logger.js";
import { collapseIfNeeded } from "./pipeline-collapse.js";
import {
  checkConvergence,
  runAtomicityPhase,
  runDirtyTreePhase,
  runGatePhase,
} from "./pipeline-phases.js";
import { isGitRepo } from "./phases/dirty-tree.js";
import { isGitUnchanged, resolveBaseSHA } from "./phases/git-status.js";
import { recordPriorCycleCompletion } from "./pipeline-record.js";
import { getCommitCount, runReviewIfNeeded } from "./pipeline-review.js";
import { isCycleInProgress, skipReason } from "./pipeline-skip.js";
import type { RuntimeState } from "./runtime.js";
import { type CleanupState, TransitionEvent, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";
import {
  AttemptCount as AttemptCountSchema,
  type AttemptCount,
  type CommitSHA,
  decodeCommitSHA,
  type GateConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum cleanup attempts before stalling. */
const MAX_ATTEMPTS = 5;

/** Decode 0 as an AttemptCount. */
const NO_ATTEMPTS: AttemptCount = Schema.decodeUnknownSync(AttemptCountSchema)(0);

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
export const getAttempts = (state: CleanupState): AttemptCount =>
  Match.value(state).pipe(
    Match.tag("Idle", () => NO_ATTEMPTS),
    Match.tag("WaitingForTreeFix", (s) => s.attempts),
    Match.tag("WaitingForGateFix", (s) => s.attempts),
    Match.tag("WaitingForFactoring", (s) => s.attempts),
    // Non-actionable states: unreachable here in production (the
    // Handler gates on isActionable before calling getAttempts) but
    // Enumerated so a new CleanupState variant produces a compile
    // Error. Exported so tests can exercise these arms directly.
    Match.tag("AwaitingUserInput", () => NO_ATTEMPTS),
    Match.tag("Disabled", () => NO_ATTEMPTS),
    Match.exhaustive,
  );

export { recordPriorCycleCompletion } from "./pipeline-record.js";

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
 * Record prior-cycle completion, then stall on max attempts only if
 * the agent did not make observable progress. If progress was
 * recorded, the subsequent phase run will transition state out of
 * the waiting variant and reset the counter.
 *
 * @param pi - The extension API for exec.
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context for stall notifications.
 * @returns True if the handler should return early (stalled).
 */
const recordThenCheckMaxAttempts = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<boolean> => {
  const actionsBefore = runtime.cycleActions.length;
  await recordPriorCycleCompletion(pi, runtime);
  const madeProgress = runtime.cycleActions.length > actionsBefore;

  return !madeProgress && checkMaxAttempts(runtime, ctx);
};

/**
 * First pass sends eval prompt; second pass collapses via navigateTree.
 *
 * @param pi - The extension API.
 * @param runtime - The mutable runtime state.
 */
const runEvalOrComplete = async (pi: ExtensionAPI, runtime: RuntimeState): Promise<void> => {
  if (!runtime.evalPending) {
    runtime.evalPending = true;
    pi.sendUserMessage(EVAL_MESSAGE);

    return;
  }

  runtime.evalPending = false;
  runtime.cycleComplete = true;
  runtime.mutationDetected = false;
  runtime.cycleActions.push("Verified task completion");
  await collapseIfNeeded(runtime);
};

/** Context for the git-dependent phases. */
interface GitPhaseContext {
  readonly pi: ExtensionAPI;
  readonly runtime: RuntimeState;
  readonly ctx: ExtensionContext;
  readonly gateConfig: GateConfig;
}

/**
 * Read and decode `git rev-parse HEAD`, warning on parse failure.
 *
 * Git parse failures previously fell through silently to Indeterminate
 * / skip paths, hiding configuration or corruption problems. Logging
 * once per failure site makes the cause visible in extension logs.
 *
 * @param pi - The extension API for exec.
 * @param context - A short tag describing the call site for logs.
 * @returns The decoded HEAD SHA as an Either.
 */
const readHead = async (
  pi: ExtensionAPI,
  context: string,
): Promise<Either.Either<CommitSHA, unknown>> => {
  const headResult = await pi.exec("git", ["rev-parse", "HEAD"]);
  const headEither = decodeCommitSHA(headResult.stdout.trim());

  if (Either.isLeft(headEither)) {
    warn(
      context,
      `failed to parse HEAD SHA (exit=${String(headResult.code)}, stdout="${headResult.stdout.slice(0, 80)}")`,
    );
  }

  return headEither;
};

/**
 * Run git-dependent phases: dirty tree + review + atomicity.
 *
 * @param phaseCtx - The git-phase context with the unwrapped gateConfig.
 * @returns True if a phase needs agent action.
 */
const runGitPhases = async (phaseCtx: GitPhaseContext): Promise<boolean> => {
  const { pi, runtime, ctx, gateConfig } = phaseCtx;

  if (!(await isGitRepo(pi.exec.bind(pi)))) {
    return false;
  }

  if (await runDirtyTreePhase(pi, runtime, ctx)) {
    return true;
  }

  const headEither = await readHead(pi, "runGitPhases");
  const baseSHA = await resolveBaseSHA(pi.exec.bind(pi), runtime.lastCleanCommitSHA);
  const commitCount = await getCommitCount(pi, headEither, baseSHA);

  const reviewOutcome = runReviewIfNeeded({
    baseSHA,
    commitCount,
    headEither,
    phaseCtx: { ctx, pi, runtime },
  });

  if (
    Match.value(reviewOutcome).pipe(
      Match.tag("Requested", (): true => true),
      Match.tag("Completed", (): true => true),
      Match.tag("Skipped", (): false => false),
      Match.exhaustive,
    )
  ) {
    return true;
  }

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
  if (Option.isSome(skipReason(runtime))) {
    return;
  }

  if (
    runtime.cleanup._tag === "Idle" &&
    !isCycleInProgress(runtime) &&
    (await isGitUnchanged(pi.exec.bind(pi), runtime.lastCleanCommitSHA))
  ) {
    runtime.mutationDetected = false;

    return;
  }

  if (await recordThenCheckMaxAttempts(pi, runtime, ctx)) {
    return;
  }

  await checkConvergence(pi, runtime, ctx);

  const gateResult = await runGatePhase(pi, runtime, ctx);

  if (Option.isNone(gateResult)) {
    return;
  }

  if (await runGitPhases({ ctx, gateConfig: gateResult.value, pi, runtime })) {
    return;
  }

  await runEvalOrComplete(pi, runtime);
};

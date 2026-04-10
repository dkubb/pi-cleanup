/**
 * Cleanup pipeline: gates → dirty tree → atomicity.
 *
 * Gates run first so we never commit code that doesn't pass them.
 * Once gates pass, we commit any dirty files (known-good code),
 * then check atomicity.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Either, Match, Option, Schema } from "effect";

import { persistCleanCommit } from "./persistence.js";
import { buildFactorMessage, checkAtomicity } from "./phases/atomicity.js";
import { buildDirtyTreeMessage, checkGitStatus } from "./phases/dirty-tree.js";
import { buildGateFixMessage, runGates } from "./phases/gates.js";
import type { RuntimeState } from "./runtime.js";
import { type CleanupState, TransitionEvent, isActionable, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";
import {
  AttemptCount as AttemptCountSchema,
  type AttemptCount,
  type GateConfig,
  decodeCommitSHA,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum cleanup attempts before stalling. */
const MAX_ATTEMPTS = 5;

/** Decode 0 as an AttemptCount. */
const ZERO_ATTEMPTS: AttemptCount = Schema.decodeUnknownSync(AttemptCountSchema)(0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the attempt count from the current state.
 *
 * @param state - The current cleanup state.
 * @returns The attempt count (0 for Idle, state.attempts for WaitingFor*).
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
 * Prepend a boomerang anchor instruction if needed.
 *
 * @param runtime - The runtime state.
 * @param message - The fix message to send.
 * @returns The message with anchor instruction prepended if applicable.
 */
const withBoomerangAnchor = (runtime: RuntimeState, message: string): string => {
  if (runtime.boomerangAvailable && !runtime.boomerangAnchorSet) {
    runtime.boomerangAnchorSet = true;

    return `First, call the boomerang tool with no arguments to set an anchor point. Then:\n\n${message}`;
  }

  return message;
};

/**
 * Dispatch a transition, update status, and return the new state.
 *
 * @param runtime - The runtime state.
 * @param ctx - The extension context.
 * @param event - The transition event to dispatch.
 * @returns The new cleanup state.
 */
const dispatch = (runtime: RuntimeState, ctx: ExtensionContext, event: TransitionEvent): void => {
  runtime.cleanup = transition(runtime.cleanup, event);
  updateStatus(ctx, runtime.cleanup);
};

/**
 * Send a boomerang collapse message if an anchor is active.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 */
const collapseBoomerangIfNeeded = (pi: ExtensionAPI, runtime: RuntimeState): void => {
  if (runtime.boomerangAnchorSet) {
    pi.sendUserMessage(
      "Cleanup complete. Call the boomerang tool with no arguments to collapse the cleanup context.",
    );
    runtime.boomerangAnchorSet = false;
  }
};

/**
 * Check for factoring convergence when in WaitingForFactoring.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 * @param ctx - The extension context.
 * @returns True if converged (caller should return).
 */
const checkConvergence = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<boolean> => {
  if (runtime.cleanup._tag !== "WaitingForFactoring") {
    return false;
  }

  const headResult = await pi.exec("git", ["rev-parse", "HEAD"]);
  const headEither = decodeCommitSHA(headResult.stdout.trim());

  if (Either.isLeft(headEither)) {
    return false;
  }

  if (String(headEither.right) !== String(runtime.cleanup.priorHeadSHA)) {
    return false;
  }

  const headSHA = headEither.right;
  dispatch(runtime, ctx, TransitionEvent.FactoringConverged({ headSHA }));
  persistCleanCommit(pi.appendEntry.bind(pi), headSHA);
  runtime.lastCleanCommitSHA = Option.some(headSHA);
  collapseBoomerangIfNeeded(pi, runtime);

  return true;
};

/**
 * Run phase 1: dirty tree check.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 * @param ctx - The extension context.
 * @returns True if handled (dirty or not a repo), false to continue.
 */
const runDirtyTreePhase = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<boolean> => {
  const result = await checkGitStatus(pi.exec.bind(pi));

  return Match.value(result).pipe(
    Match.tag("Dirty", (r): true => {
      dispatch(runtime, ctx, TransitionEvent.GitDirty(r));
      pi.sendUserMessage(withBoomerangAnchor(runtime, buildDirtyTreeMessage(r.porcelain)));

      return true;
    }),
    Match.tag("NotARepo", (): true => {
      dispatch(runtime, ctx, TransitionEvent.NotARepo());

      return true;
    }),
    Match.tag("Clean", (): false => false),
    Match.exhaustive,
  );
};

/**
 * Run phase 2: gate check.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 * @param ctx - The extension context.
 * @returns True if handled (failed or no config), false to continue.
 */
const runGatePhase = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<boolean> => {
  if (Option.isNone(runtime.gateConfig)) {
    dispatch(runtime, ctx, TransitionEvent.NoGateConfig());
    ctx.ui.notify("No quality gates configured. Use /gates to set up.", "warning");

    return true;
  }

  const result = await runGates(pi.exec.bind(pi), runtime.gateConfig.value);

  return Match.value(result).pipe(
    Match.tag("Failed", (r): true => {
      dispatch(runtime, ctx, TransitionEvent.GateFailed(r));
      pi.sendUserMessage(withBoomerangAnchor(runtime, buildGateFixMessage(r.command, r.output)));

      return true;
    }),
    Match.tag("AllPassed", (): false => false),
    Match.exhaustive,
  );
};

/** Context for the atomicity phase. */
interface AtomicityPhaseContext {
  readonly pi: ExtensionAPI;
  readonly runtime: RuntimeState;
  readonly ctx: ExtensionContext;
  readonly gateConfig: GateConfig;
}

/**
 * Run phase 3: atomicity check.
 *
 * @param phaseCtx - The atomicity phase context.
 */
const runAtomicityPhase = async (phaseCtx: AtomicityPhaseContext): Promise<void> => {
  const { pi, runtime, ctx, gateConfig } = phaseCtx;
  const result = await checkAtomicity(pi.exec.bind(pi), runtime.lastCleanCommitSHA);

  Match.value(result).pipe(
    Match.tag("NeedsFactoring", (r) => {
      dispatch(runtime, ctx, TransitionEvent.NeedsFactoring(r));
      pi.sendUserMessage(
        withBoomerangAnchor(runtime, buildFactorMessage(r.baseSHA, r.headSHA, gateConfig.commands)),
      );
    }),
    Match.tag("Atomic", (r) => {
      dispatch(runtime, ctx, TransitionEvent.Atomic(r));
      persistCleanCommit(pi.appendEntry.bind(pi), r.headSHA);
      runtime.lastCleanCommitSHA = Option.some(r.headSHA);
    }),
    Match.tag("NoBase", (r) => {
      dispatch(runtime, ctx, TransitionEvent.NoBase(r));
      persistCleanCommit(pi.appendEntry.bind(pi), r.headSHA);
      runtime.lastCleanCommitSHA = Option.some(r.headSHA);
    }),
    Match.tag("Indeterminate", () => {
      dispatch(runtime, ctx, TransitionEvent.Indeterminate());
    }),
    Match.exhaustive,
  );

  if (runtime.cleanup._tag === "Idle") {
    collapseBoomerangIfNeeded(pi, runtime);
  }
};

/**
 * Check guard conditions before running the pipeline.
 *
 * @param runtime - The runtime state.
 * @returns True if the pipeline should be skipped.
 */
const shouldSkip = (runtime: RuntimeState): boolean =>
  !isActionable(runtime.cleanup) || globalThis.__boomerangCollapseInProgress === true;

/**
 * Handle agent_end: run the cleanup pipeline.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 * @param ctx - The extension context.
 */
export const handleAgentEnd = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<void> => {
  if (shouldSkip(runtime)) {
    return;
  }

  if (getAttempts(runtime.cleanup) >= MAX_ATTEMPTS) {
    dispatch(runtime, ctx, TransitionEvent.MaxAttemptsExceeded());
    ctx.ui.notify(
      "Cleanup stalled after too many attempts. Use /cleanup resume to retry.",
      "warning",
    );

    return;
  }

  if (await checkConvergence(pi, runtime, ctx)) {
    return;
  }

  if (await runGatePhase(pi, runtime, ctx)) {
    return;
  }

  if (await runDirtyTreePhase(pi, runtime, ctx)) {
    return;
  }

  // Gate config guaranteed Some by runGatePhase guard
  await runAtomicityPhase({ ctx, gateConfig: Option.getOrThrow(runtime.gateConfig), pi, runtime });
};

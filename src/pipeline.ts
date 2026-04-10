/**
 * Cleanup pipeline orchestrator.
 *
 * Wires the phase runners (gates → dirty tree → atomicity → eval)
 * into the `agent_end` handler with guard checks, attempt limiting,
 * and boomerang collapse.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Match, Option, Schema } from "effect";

import {
  checkConvergence,
  collapseBoomerangIfNeeded,
  runAtomicityPhase,
  runDirtyTreePhase,
  runGatePhase,
  withBoomerangAnchor,
} from "./pipeline-phases.js";
import type { RuntimeState } from "./runtime.js";
import { type CleanupState, TransitionEvent, isActionable, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";
import { AttemptCount as AttemptCountSchema, type AttemptCount } from "./types.js";

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
 * AwaitingUserInput) or when boomerang is mid-collapse.
 *
 * @param runtime - The runtime state to check.
 * @returns True if the pipeline should not run.
 */
const shouldSkip = (runtime: RuntimeState): boolean =>
  !isActionable(runtime.cleanup) || globalThis.__boomerangCollapseInProgress === true;

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
 * Phase 4: completion eval, then finalize.
 *
 * On the first pass after all phases succeed, sends an eval prompt
 * asking the LLM to verify its work is complete. On the second
 * pass (after eval), finalizes by collapsing boomerang context.
 *
 * @param pi - The extension API for sending messages.
 * @param runtime - The mutable runtime state.
 */
const runEvalOrComplete = (pi: ExtensionAPI, runtime: RuntimeState): void => {
  if (!runtime.evalPending) {
    runtime.evalPending = true;
    pi.sendUserMessage(withBoomerangAnchor(runtime, EVAL_MESSAGE));

    return;
  }

  runtime.evalPending = false;
  collapseBoomerangIfNeeded(pi, runtime);
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
  const gateConfig = Option.getOrThrow(runtime.gateConfig);

  if (!(await runAtomicityPhase({ ctx, gateConfig, pi, runtime }))) {
    return;
  }

  runEvalOrComplete(pi, runtime);
};

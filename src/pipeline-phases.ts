/**
 * Pipeline phase runners for the cleanup extension.
 *
 * Each phase is a self-contained async function that runs one step
 * of the cleanup pipeline: gates, dirty tree, atomicity, or eval.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Either, Match, Option } from "effect";

import { captureCollapseAnchor } from "./pipeline-collapse.js";
import { persistCleanCommit } from "./persistence.js";
import { buildFactorMessage, checkAtomicity } from "./phases/atomicity.js";
import { buildDirtyTreeMessage, checkGitStatus } from "./phases/dirty-tree.js";
import { buildGateFixMessage, runGates } from "./phases/gates.js";
import type { RuntimeState } from "./runtime.js";
import { TransitionEvent, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";
import { type CommitSHA, type GateConfig, decodeCommitSHA } from "./types.js";

/**
 * Dispatch a transition event and update the status widget.
 *
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context for status updates.
 * @param event - The transition event to dispatch.
 */
export const dispatch = (
  runtime: RuntimeState,
  ctx: ExtensionContext,
  event: TransitionEvent,
): void => {
  runtime.cleanup = transition(runtime.cleanup, event);
  updateStatus(ctx, runtime.cleanup);
};

/**
 * Check for factoring convergence when in WaitingForFactoring.
 *
 * If HEAD hasn't moved since the last factoring request, the agent
 * decided no further splitting was needed. Persist the SHA and
 * complete the cycle.
 *
 * @param pi - The extension API for exec and persistence.
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context for status updates.
 * @returns True if converged (caller should return early).
 */
export const checkConvergence = async (
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

  return true;
};

/**
 * Run quality gates against the working tree.
 *
 * If no gate config exists, transitions to AwaitingUserInput.
 * If a gate fails, sends the agent a fix message.
 *
 * @param pi - The extension API for exec and messaging.
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context for notifications.
 * @returns True if the phase handled the event (caller should return).
 */
export const runGatePhase = async (
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
      captureCollapseAnchor(runtime, ctx);
      pi.sendUserMessage(buildGateFixMessage(r.command, r.output));

      return true;
    }),
    Match.tag("AllPassed", (): false => {
      if (runtime.cleanup._tag === "WaitingForGateFix") {
        runtime.cycleActions.push(`Fixed failing gate: \`${String(runtime.cleanup.failedGate)}\``);
      }
      return false;
    }),
    Match.exhaustive,
  );
};

/**
 * Check the working tree for uncommitted changes.
 *
 * Runs after gates pass, so any dirty files are known-good code.
 * Asks the agent to commit them using conventional commit format.
 *
 * @param pi - The extension API for exec and messaging.
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context for status updates.
 * @returns True if the phase handled the event (caller should return).
 */
export const runDirtyTreePhase = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<boolean> => {
  const result = await checkGitStatus(pi.exec.bind(pi));

  return Match.value(result).pipe(
    Match.tag("Dirty", (r): true => {
      dispatch(runtime, ctx, TransitionEvent.GitDirty(r));
      captureCollapseAnchor(runtime, ctx);
      pi.sendUserMessage(buildDirtyTreeMessage(r.porcelain));

      return true;
    }),
    Match.tag("NotARepo", (): true => {
      dispatch(runtime, ctx, TransitionEvent.NotARepo());

      return true;
    }),
    Match.tag("Clean", (): false => {
      if (runtime.cleanup._tag === "WaitingForTreeFix") {
        runtime.cycleActions.push("Committed uncommitted changes");
      }
      return false;
    }),
    Match.exhaustive,
  );
};

/** Context for the atomicity phase. */
export interface AtomicityPhaseContext {
  readonly pi: ExtensionAPI;
  readonly runtime: RuntimeState;
  readonly ctx: ExtensionContext;
  readonly gateConfig: GateConfig;
  readonly baseSHA: Option.Option<CommitSHA>;
}

/** Context for handling a successful atomicity result. */
interface AtomicitySuccessContext extends Pick<AtomicityPhaseContext, "pi" | "runtime" | "ctx"> {
  readonly event: TransitionEvent;
  readonly headSHA: CommitSHA;
}

/**
 * Handle a passing atomicity result: dispatch event, persist SHA.
 *
 * @param sc - The success context with all required values.
 */
const handleAtomicitySuccess = (sc: AtomicitySuccessContext): void => {
  dispatch(sc.runtime, sc.ctx, sc.event);
  persistCleanCommit(sc.pi.appendEntry.bind(sc.pi), sc.headSHA);
  sc.runtime.lastCleanCommitSHA = Option.some(sc.headSHA);
};

/**
 * Check whether recent commits need splitting for atomicity.
 *
 * If commits need factoring, sends the agent a message with the
 * commit range and gate commands. Otherwise persists the clean SHA.
 *
 * @param phaseCtx - The atomicity phase context.
 * @returns True if atomicity passed (caller should proceed to eval).
 */
export const runAtomicityPhase = async (phaseCtx: AtomicityPhaseContext): Promise<boolean> => {
  const { pi, runtime, ctx, gateConfig, baseSHA } = phaseCtx;
  const result = await checkAtomicity(pi.exec.bind(pi), baseSHA);

  return Match.value(result).pipe(
    Match.tag("NeedsFactoring", (r): false => {
      dispatch(runtime, ctx, TransitionEvent.NeedsFactoring(r));
      captureCollapseAnchor(runtime, ctx);
      pi.sendUserMessage(buildFactorMessage(r.baseSHA, r.headSHA, gateConfig.commands));

      return false;
    }),
    Match.tag("Atomic", (r): true => {
      if (runtime.cleanup._tag === "WaitingForFactoring") {
        runtime.cycleActions.push("Factored commits into atomic units");
      }
      handleAtomicitySuccess({
        ctx,
        event: TransitionEvent.Atomic(r),
        headSHA: r.headSHA,
        pi,
        runtime,
      });

      return true;
    }),
    Match.tag("NoBase", (r): true => {
      handleAtomicitySuccess({
        ctx,
        event: TransitionEvent.NoBase(r),
        headSHA: r.headSHA,
        pi,
        runtime,
      });

      return true;
    }),
    Match.tag("Indeterminate", (): true => {
      dispatch(runtime, ctx, TransitionEvent.Indeterminate());

      return true;
    }),
    Match.exhaustive,
  );
};

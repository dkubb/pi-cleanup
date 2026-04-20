/**
 * Pipeline phase runners for the cleanup extension.
 *
 * Each phase is a self-contained async function that runs one step
 * of the cleanup pipeline: gates, dirty tree, atomicity, or eval.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Data, Either, Match, Option } from "effect";

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
 * @returns Some(GateConfig) if gates passed and the caller should
 *   continue; None if the phase handled the event (caller returns).
 *   Returning the unwrapped GateConfig lets later phases use it
 *   without an unchecked Option.getOrThrow on runtime state.
 */
export const runGatePhase = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<Option.Option<GateConfig>> => {
  if (Option.isNone(runtime.gateConfig)) {
    dispatch(runtime, ctx, TransitionEvent.NoGateConfig());
    ctx.ui.notify("No quality gates configured. Use /gates to set up.", "warning");

    return Option.none();
  }

  const gateConfig = runtime.gateConfig.value;
  const result = await runGates(pi.exec.bind(pi), gateConfig);

  return Match.value(result).pipe(
    Match.tag("Failed", (r): Option.Option<GateConfig> => {
      dispatch(runtime, ctx, TransitionEvent.GateFailed(r));
      pi.sendUserMessage(buildGateFixMessage(r.command, r.output));

      return Option.none();
    }),
    Match.tag("AllPassed", (): Option.Option<GateConfig> => {
      if (runtime.cleanup._tag === "WaitingForGateFix") {
        dispatch(runtime, ctx, TransitionEvent.GatesPassed());
      }
      return Option.some(gateConfig);
    }),
    Match.exhaustive,
  );
};

/** Outcome of running the dirty-tree phase for this cycle. */
export type DirtyTreePhaseOutcome = Data.TaggedEnum<{
  /** Tree is dirty; commit nudge sent; caller must stop. */
  readonly CommitRequested: { readonly porcelain: string };
  /** Git status failed; state updated to reflect not-a-repo. */
  readonly NotARepo: {};
  /** Tree is clean; caller may continue to review/atomicity/eval. */
  readonly Clean: {};
}>;

/** Constructor namespace for {@link DirtyTreePhaseOutcome} variants. */
export const DirtyTreePhaseOutcome = Data.taggedEnum<DirtyTreePhaseOutcome>();

/**
 * Check the working tree for uncommitted changes.
 *
 * Runs after gates pass, so any dirty files are known-good code.
 * Asks the agent to commit them using conventional commit format.
 *
 * @param pi - The extension API for exec and messaging.
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context for status updates.
 * @returns A tagged outcome naming whether a commit was requested,
 *   git status reported not-a-repo, or the tree is clean.
 */
export const runDirtyTreePhase = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionContext,
): Promise<DirtyTreePhaseOutcome> => {
  const result = await checkGitStatus(pi.exec.bind(pi));

  return Match.value(result).pipe(
    Match.tag("Dirty", (r): DirtyTreePhaseOutcome => {
      dispatch(runtime, ctx, TransitionEvent.GitDirty(r));
      pi.sendUserMessage(buildDirtyTreeMessage(r.porcelain));

      return DirtyTreePhaseOutcome.CommitRequested(r);
    }),
    Match.tag("NotARepo", (): DirtyTreePhaseOutcome => {
      dispatch(runtime, ctx, TransitionEvent.NotARepo());

      return DirtyTreePhaseOutcome.NotARepo();
    }),
    Match.tag("Clean", (): DirtyTreePhaseOutcome => {
      if (runtime.cleanup._tag === "WaitingForTreeFix") {
        dispatch(runtime, ctx, TransitionEvent.GitClean());
      }
      return DirtyTreePhaseOutcome.Clean();
    }),
    Match.exhaustive,
  );
};

/** Outcome of running the atomicity phase for this cycle. */
export type AtomicityPhaseOutcome = Data.TaggedEnum<{
  /** Commits need factoring; nudge sent; caller must stop. */
  readonly FactoringRequested: {
    readonly baseSHA: CommitSHA;
    readonly commitCount: number;
    readonly headSHA: CommitSHA;
  };
  /** Atomicity confirmed; caller may proceed to eval. */
  readonly Atomic: { readonly headSHA: CommitSHA };
  /** No comparable base; caller may proceed to eval. */
  readonly NoBase: { readonly headSHA: CommitSHA };
  /** Rev-list or HEAD could not be parsed; caller may proceed to eval. */
  readonly Indeterminate: {};
}>;

/** Constructor namespace for {@link AtomicityPhaseOutcome} variants. */
export const AtomicityPhaseOutcome = Data.taggedEnum<AtomicityPhaseOutcome>();

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
 * @returns A tagged outcome naming whether factoring was requested,
 *   atomicity passed, no base was available, or the result was
 *   indeterminate this cycle.
 */
export const runAtomicityPhase = async (
  phaseCtx: AtomicityPhaseContext,
): Promise<AtomicityPhaseOutcome> => {
  const { pi, runtime, ctx, gateConfig, baseSHA } = phaseCtx;
  const result = await checkAtomicity(pi.exec.bind(pi), baseSHA);

  return Match.value(result).pipe(
    Match.tag("NeedsFactoring", (r) => {
      dispatch(runtime, ctx, TransitionEvent.NeedsFactoring(r));
      pi.sendUserMessage(buildFactorMessage(r.baseSHA, r.headSHA, gateConfig.commands));

      return AtomicityPhaseOutcome.FactoringRequested(r);
    }),
    Match.tag("Atomic", (r) => {
      handleAtomicitySuccess({
        ctx,
        event: TransitionEvent.Atomic(r),
        headSHA: r.headSHA,
        pi,
        runtime,
      });

      return AtomicityPhaseOutcome.Atomic(r);
    }),
    Match.tag("NoBase", (r) => {
      handleAtomicitySuccess({
        ctx,
        event: TransitionEvent.NoBase(r),
        headSHA: r.headSHA,
        pi,
        runtime,
      });

      return AtomicityPhaseOutcome.NoBase(r);
    }),
    Match.tag("Indeterminate", () => {
      dispatch(runtime, ctx, TransitionEvent.Indeterminate());

      return AtomicityPhaseOutcome.Indeterminate();
    }),
    Match.exhaustive,
  );
};

/**
 * State machine for the cleanup extension.
 *
 * Defines the CleanupState (6-variant tagged enum), TransitionEvent
 * (~15-variant tagged enum), and the pure transition function that
 * maps (state, event) → new state.
 *
 * Uses Effect Data.TaggedEnum for structural equality and
 * Match.exhaustive for compile-time exhaustiveness checking.
 *
 * @module
 */

import { Data, Match, Schema } from "effect";

import {
  type AttemptCount,
  AttemptCount as AttemptCountSchema,
  AwaitingReason,
  type CommitSHA,
  type GateCommand,
  incrementAttempt,
} from "./types.js";

// ---------------------------------------------------------------------------
// TransitionEvent Type
// ---------------------------------------------------------------------------

/**
 * Events that drive state transitions in the cleanup state machine.
 *
 * Pipeline events are emitted by the `agent_end` handler during
 * evaluation. Command events are emitted by `/cleanup`, `/gates`,
 * and the `session_start` handler.
 *
 * Non-actionable states (Disabled, AwaitingUserInput) ignore pipeline
 * events and only respond to command events.
 */
export type TransitionEvent = Data.TaggedEnum<{
  // -- Pipeline events (emitted during agent_end evaluation) --

  /** Working tree has uncommitted changes. */
  readonly GitDirty: { readonly porcelain: string };
  /** Working tree is clean. */
  readonly GitClean: {};
  /** Not inside a git repository. */
  readonly NotARepo: {};
  /** A gate command failed. */
  readonly GateFailed: {
    readonly command: GateCommand;
    readonly output: string;
  };
  /** All gate commands passed. */
  readonly GatesPassed: {};
  /** No gate configuration exists. */
  readonly NoGateConfig: {};
  /** Commits in range need factoring into atomic units. */
  readonly NeedsFactoring: {
    readonly headSHA: CommitSHA;
    readonly baseSHA: CommitSHA;
  };
  /** HEAD unchanged after factoring — factoring has converged. */
  readonly FactoringConverged: { readonly headSHA: CommitSHA };
  /** Commits are already atomic (≤1 commit since base). */
  readonly Atomic: { readonly headSHA: CommitSHA };
  /** No base SHA determinable — cannot assess atomicity. */
  readonly NoBase: { readonly headSHA: CommitSHA };
  /** HEAD could not be determined — skip atomicity check. */
  readonly Indeterminate: {};
  /** Retry attempts exceeded the configured maximum. */
  readonly MaxAttemptsExceeded: {};

  // -- Command events (emitted by user commands / session lifecycle) --

  /** User ran `/cleanup on`. */
  readonly UserEnabled: {};
  /** User ran `/cleanup off`. */
  readonly UserDisabled: {};
  /** User ran `/cleanup resume`. */
  readonly UserResumed: {};
  /** User configured gates via `/gates`. */
  readonly GatesConfigured: {};
  /** A new session started or was reloaded. */
  readonly SessionStarted: {};
}>;

/** Constructor namespace for {@link TransitionEvent} variants. */
export const TransitionEvent = Data.taggedEnum<TransitionEvent>();

// ---------------------------------------------------------------------------
// CleanupState Union
// ---------------------------------------------------------------------------

/**
 * Resting states of the cleanup state machine.
 *
 * Only resting states (those that persist between agent runs) are
 * modeled. Transient evaluation (running git status, executing gates)
 * happens procedurally within the handler and does not need its own state.
 *
 * - `Idle`: No cleanup in progress. Handler will do a fresh evaluation.
 * - `WaitingForTreeFix`: Sent a message to commit dirty files.
 * - `WaitingForGateFix`: Sent a message to fix a gate failure.
 * - `WaitingForFactoring`: Sent a message to factor commits.
 * - `AwaitingUserInput`: Blocked on user action (/gates or /cleanup resume).
 * - `Disabled`: Extension turned off via /cleanup off.
 */
export type CleanupState = Data.TaggedEnum<{
  /** No cleanup in progress. */
  readonly Idle: {};
  /** Waiting for agent to commit dirty files. */
  readonly WaitingForTreeFix: { readonly attempts: AttemptCount };
  /** Waiting for agent to fix a gate failure. */
  readonly WaitingForGateFix: {
    readonly attempts: AttemptCount;
    readonly failedGate: GateCommand;
  };
  /** Waiting for agent to factor commits into atomic units. */
  readonly WaitingForFactoring: {
    readonly attempts: AttemptCount;
    readonly priorHeadSHA: CommitSHA;
  };
  /** Blocked on user action. See {@link AwaitingReason} for why. */
  readonly AwaitingUserInput: { readonly reason: AwaitingReason };
  /** Extension disabled by user. */
  readonly Disabled: {};
}>;

/** Constructor namespace for {@link CleanupState} variants. */
export const CleanupState = Data.taggedEnum<CleanupState>();

/** Initial state on extension load and session start. */
export const INITIAL_STATE: CleanupState = CleanupState.Idle();

/**
 * Whether the given state should trigger the agent_end handler.
 *
 * Returns `true` for states where the handler should run (Idle and
 * all WaitingFor* states). Returns `false` for AwaitingUserInput
 * and Disabled.
 *
 * Uses Match.exhaustive — adding a new CleanupState variant without
 * handling it here produces a compile error.
 *
 * @param state - The current cleanup state.
 * @returns `true` if the handler should proceed, `false` otherwise.
 *
 * @example
 * ```ts
 * assert(isActionable(CleanupState.Idle()) === true);
 * assert(isActionable(CleanupState.Disabled()) === false);
 * ```
 */
export const isActionable: (state: CleanupState) => boolean = Match.type<CleanupState>().pipe(
  Match.tag("Idle", () => true),
  Match.tag("WaitingForTreeFix", () => true),
  Match.tag("WaitingForGateFix", () => true),
  Match.tag("WaitingForFactoring", () => true),
  Match.tag("AwaitingUserInput", () => false),
  Match.tag("Disabled", () => false),
  Match.exhaustive,
);

// ---------------------------------------------------------------------------
// Transition Function
// ---------------------------------------------------------------------------

/** Decode 1 as an AttemptCount (first attempt from Idle). */
const FIRST_ATTEMPT: AttemptCount = Schema.decodeUnknownSync(AttemptCountSchema)(1);

/** Context for a WaitingFor* → event transition. */
interface WaitingContext {
  readonly state: CleanupState;
  readonly event: TransitionEvent;
  readonly phase: string;
  readonly attempts: AttemptCount;
}

/**
 * Handle a transition event from an actionable WaitingFor* state.
 *
 * @param ctx - The waiting state context.
 * @returns The new cleanup state.
 */
const transitionFromWaiting = (ctx: WaitingContext): CleanupState =>
  Match.value(ctx.event).pipe(
    Match.tag("GitDirty", () =>
      CleanupState.WaitingForTreeFix({ attempts: incrementAttempt(ctx.attempts) }),
    ),
    Match.tag("GitClean", () => CleanupState.Idle()),
    Match.tag("NotARepo", () => CleanupState.Idle()),
    Match.tag("GateFailed", (e) =>
      CleanupState.WaitingForGateFix({
        attempts: incrementAttempt(ctx.attempts),
        failedGate: e.command,
      }),
    ),
    Match.tag("GatesPassed", () => CleanupState.Idle()),
    Match.tag("NoGateConfig", () =>
      CleanupState.AwaitingUserInput({ reason: AwaitingReason.GatesUnconfigured() }),
    ),
    Match.tag("NeedsFactoring", (e) =>
      CleanupState.WaitingForFactoring({
        attempts: incrementAttempt(ctx.attempts),
        priorHeadSHA: e.headSHA,
      }),
    ),
    Match.tag("FactoringConverged", () => CleanupState.Idle()),
    Match.tag("Atomic", () => CleanupState.Idle()),
    Match.tag("NoBase", () => CleanupState.Idle()),
    Match.tag("Indeterminate", () => CleanupState.Idle()),
    Match.tag("MaxAttemptsExceeded", () =>
      CleanupState.AwaitingUserInput({
        reason: AwaitingReason.Stalled({ attempts: ctx.attempts, phase: ctx.phase }),
      }),
    ),
    Match.tag("UserDisabled", () => CleanupState.Disabled()),
    Match.tag("SessionStarted", () => CleanupState.Idle()),
    Match.tag("UserEnabled", () => ctx.state),
    Match.tag("UserResumed", () => ctx.state),
    Match.tag("GatesConfigured", () => ctx.state),
    Match.exhaustive,
  );

/**
 * Handle a transition event from the Idle state.
 *
 * @param event - The transition event to process.
 * @returns The new cleanup state.
 */
const transitionFromIdle = (event: TransitionEvent): CleanupState =>
  Match.value(event).pipe(
    Match.tag("GitDirty", () => CleanupState.WaitingForTreeFix({ attempts: FIRST_ATTEMPT })),
    Match.tag("GitClean", () => CleanupState.Idle()),
    Match.tag("NotARepo", () => CleanupState.Idle()),
    Match.tag("GateFailed", (e) =>
      CleanupState.WaitingForGateFix({ attempts: FIRST_ATTEMPT, failedGate: e.command }),
    ),
    Match.tag("GatesPassed", () => CleanupState.Idle()),
    Match.tag("NoGateConfig", () =>
      CleanupState.AwaitingUserInput({ reason: AwaitingReason.GatesUnconfigured() }),
    ),
    Match.tag("NeedsFactoring", (e) =>
      CleanupState.WaitingForFactoring({ attempts: FIRST_ATTEMPT, priorHeadSHA: e.headSHA }),
    ),
    Match.tag("FactoringConverged", () => CleanupState.Idle()),
    Match.tag("Atomic", () => CleanupState.Idle()),
    Match.tag("NoBase", () => CleanupState.Idle()),
    Match.tag("Indeterminate", () => CleanupState.Idle()),
    Match.tag("MaxAttemptsExceeded", () => CleanupState.Idle()),
    Match.tag("UserDisabled", () => CleanupState.Disabled()),
    Match.tag("SessionStarted", () => CleanupState.Idle()),
    Match.tag("UserEnabled", () => CleanupState.Idle()),
    Match.tag("UserResumed", () => CleanupState.Idle()),
    Match.tag("GatesConfigured", () => CleanupState.Idle()),
    Match.exhaustive,
  );

/**
 * Pure state transition function for the cleanup state machine.
 *
 * Maps (state, event) → new state. Does not perform side effects.
 * The handler reads the new state and decides what action to take.
 *
 * @param state - The current cleanup state.
 * @param event - The transition event to process.
 * @returns The new cleanup state after applying the event.
 */
export const transition = (state: CleanupState, event: TransitionEvent): CleanupState =>
  Match.value(state).pipe(
    Match.tag("Idle", () => transitionFromIdle(event)),
    Match.tag("WaitingForTreeFix", (s) =>
      transitionFromWaiting({ attempts: s.attempts, event, phase: "WaitingForTreeFix", state }),
    ),
    Match.tag("WaitingForGateFix", (s) =>
      transitionFromWaiting({ attempts: s.attempts, event, phase: "WaitingForGateFix", state }),
    ),
    Match.tag("WaitingForFactoring", (s) =>
      transitionFromWaiting({ attempts: s.attempts, event, phase: "WaitingForFactoring", state }),
    ),
    Match.tag("AwaitingUserInput", () =>
      Match.value(event).pipe(
        Match.tag("UserResumed", () => CleanupState.Idle()),
        Match.tag("GatesConfigured", () => CleanupState.Idle()),
        Match.tag("UserDisabled", () => CleanupState.Disabled()),
        Match.tag("SessionStarted", () => CleanupState.Idle()),
        Match.orElse(() => state),
      ),
    ),
    Match.tag("Disabled", () =>
      Match.value(event).pipe(
        Match.tag("UserEnabled", () => CleanupState.Idle()),
        Match.tag("SessionStarted", () => CleanupState.Idle()),
        Match.orElse(() => state),
      ),
    ),
    Match.exhaustive,
  );

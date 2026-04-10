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

import { Data, Match } from "effect";

import type { AttemptCount, AwaitingReason, CommitSHA, GateCommand } from "./types.js";

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

/**
 * Pure state transition function for the cleanup state machine.
 *
 * Maps (state, event) → new state. Does not perform side effects
 * (no sendUserMessage, no pi.exec). The handler reads the new state
 * and decides what action to take.
 *
 * For pipeline events like GitClean and GatesPassed, the function
 * returns Idle as a no-op — the handler continues evaluating the
 * next phase rather than assigning this intermediate state.
 *
 * Uses Match.exhaustive — adding a new CleanupState or TransitionEvent
 * variant without handling it here produces a compile error.
 *
 * @param _state - The current cleanup state.
 * @param _event - The transition event to process.
 * @returns The new cleanup state after applying the event.
 *
 * @example
 * ```ts
 * // Dirty tree from idle → waiting for fix
 * const next = transition(
 *   CleanupState.Idle(),
 *   TransitionEvent.GitDirty({ porcelain: "M foo.ts" }),
 * );
 * assert(next._tag === "WaitingForTreeFix");
 *
 * // Disabled state ignores pipeline events
 * const same = transition(
 *   CleanupState.Disabled(),
 *   TransitionEvent.GitDirty({ porcelain: "M foo.ts" }),
 * );
 * assert(same._tag === "Disabled");
 * ```
 */
export const transition = (_state: CleanupState, _event: TransitionEvent): CleanupState => {
  // What: Map (state, event) → new state using exhaustive pattern matching.
  //
  // Why: A pure transition function keeps state logic testable and separates
  //      It from side effects. Match.exhaustive ensures every state×event
  //      Combination is handled at compile time.
  //
  // How: Outer match on state._tag, inner match on event._tag.
  //
  //      For actionable states (Idle, WaitingFor*):
  //      - Pipeline events create the appropriate next state.
  //      - From Idle, new attempts start at 1.
  //      - From WaitingFor*, attempts use incrementAttempt(state.attempts).
  //      - UserDisabled → Disabled from any state.
  //      - SessionStarted → Idle from any state.
  //
  //      For inactive states (AwaitingUserInput, Disabled):
  //      - Pipeline events are no-ops (return current state).
  //      - UserEnabled → Idle (from Disabled only).
  //      - UserResumed → Idle (from AwaitingUserInput only).
  //      - GatesConfigured → Idle (from AwaitingUserInput/GatesUnconfigured).
  //
  //      Special: MaxAttemptsExceeded → AwaitingUserInput(Stalled(...))
  //      From any WaitingFor* state. Impossible from Idle (no-op).

  // TODO: Implement with Match.value(state).pipe(Match.tag(...), Match.exhaustive)
  throw new Error("Not implemented");
};

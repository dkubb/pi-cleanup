/**
 * Runtime state for the cleanup extension.
 *
 * Defines the mutable state that lives in the extension closure
 * and is shared across all handlers and commands.
 *
 * @module
 */

import { Option } from "effect";

import { INITIAL_STATE, type CleanupState } from "./state-machine.js";
import type { CommandContextRef, CommitSHA, GateConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Runtime State
// ---------------------------------------------------------------------------

/** Mutable runtime state for the extension closure. */
export interface RuntimeState {
  /** Current cleanup state machine state. */
  cleanup: CleanupState;
  /** Current gate configuration, or None if unconfigured. */
  gateConfig: Option.Option<GateConfig>;
  /** Last commit SHA where cleanup completed successfully. */
  lastCleanCommitSHA: Option.Option<CommitSHA>;
  /** Whether a completion eval has been sent and is awaiting re-check. */
  evalPending: boolean;
  /** Whether the cleanup cycle completed (reset on next user prompt). */
  cycleComplete: boolean;
  /** Actions taken during this cleanup cycle, for the collapse summary. */
  cycleActions: string[];
  /** Whether a file-mutating tool ran since the last completed cycle. */
  mutationDetected: boolean;
  /** Whether code review has been requested for this cycle. */
  reviewPending: boolean;
  /** Whether code review passed for this cycle. */
  reviewComplete: boolean;
  /** Stored command context for navigateTree collapse. */
  commandCtx: Option.Option<CommandContextRef>;
  /** Leaf entry ID captured before the first cleanup message. */
  collapseAnchorId: Option.Option<string>;
}

/**
 * Create a fresh runtime state.
 *
 * @returns A RuntimeState with Idle cleanup, no gates, and no clean SHA.
 */
export const createInitialRuntimeState = (): RuntimeState => ({
  cleanup: INITIAL_STATE,
  collapseAnchorId: Option.none(),
  commandCtx: Option.none(),
  cycleActions: [],
  cycleComplete: false,
  evalPending: false,
  gateConfig: Option.none(),
  lastCleanCommitSHA: Option.none(),
  mutationDetected: true,
  reviewComplete: false,
  reviewPending: false,
});

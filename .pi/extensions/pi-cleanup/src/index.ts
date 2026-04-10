/**
 * Cleanup extension for pi.
 *
 * Hooks into `agent_end` to ensure the repository is clean and
 * well-structured after each agent interaction. Commits uncommitted
 * work, runs quality gates, and ensures commits are atomic.
 *
 * @module
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Option } from "effect";

import { INITIAL_STATE, type CleanupState } from "./state-machine.js";
import type { CommitSHA, GateConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Boomerang Coexistence
// ---------------------------------------------------------------------------

// Boomerang sets this global during context collapses.
// We skip our handler when it's true to avoid interference.
declare global {
  // eslint-disable-next-line no-var -- Must be var for global declaration
  var __boomerangCollapseInProgress: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Runtime State
// ---------------------------------------------------------------------------

/** Mutable runtime state for the extension closure. */
interface RuntimeState {
  /** Current cleanup state machine state. */
  cleanup: CleanupState;
  /** Current gate configuration, or None if unconfigured. */
  gateConfig: Option.Option<GateConfig>;
  /** Last commit SHA where cleanup completed successfully. */
  lastCleanCommitSHA: Option.Option<CommitSHA>;
}

/**
 * Create a fresh runtime state (used at load and on session_start).
 *
 * @returns A RuntimeState with Idle cleanup, no gates, and no clean SHA.
 */
const createInitialRuntimeState = (): RuntimeState => ({
  cleanup: INITIAL_STATE,
  gateConfig: Option.none(),
  lastCleanCommitSHA: Option.none(),
});

// ---------------------------------------------------------------------------
// Extension Entry Point
// ---------------------------------------------------------------------------

/**
 * Pi extension factory function.
 *
 * Registers event handlers (`session_start`, `agent_end`) and
 * commands (`/gates`, `/cleanup`). Runtime state lives in the
 * closure and is reset on each `session_start`.
 *
 * @param _pi - The pi extension API.
 */
export default function onTurnEnd(_pi: ExtensionAPI): void {
  // @ts-expect-error -- Stub: _runtime will be used by session_start and agent_end handlers
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _runtime = createInitialRuntimeState();
}

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
import { Either, Option } from "effect";

import { registerCleanupCommand, registerGatesCommand } from "./commands.js";
import { ENTRY_TYPE_COMMIT, ENTRY_TYPE_GATES } from "./persistence.js";
import { handleAgentEnd } from "./pipeline.js";
import { restoreCommitSHA, restoreGateConfig } from "./restore.js";
import { type RuntimeState, createInitialRuntimeState } from "./runtime.js";
import { INITIAL_STATE, TransitionEvent, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";
import { decodeCommitSHA } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool names that may mutate files and should trigger a cleanup cycle. */
const MUTATION_TOOLS = new Set(["bash", "edit", "write"]);

// ---------------------------------------------------------------------------
// Session Restoration Helpers
// ---------------------------------------------------------------------------

/**
 * Reset runtime state to initial values.
 *
 * @param runtime - The runtime state to reset.
 */
const resetRuntimeState = (runtime: RuntimeState): void => {
  runtime.cleanup = INITIAL_STATE;
  runtime.gateConfig = Option.none();
  runtime.lastCleanCommitSHA = Option.none();
  runtime.evalPending = false;
  runtime.cycleComplete = false;
  runtime.cycleActions = [];
  runtime.mutationDetected = true;
  runtime.reviewPending = false;
  runtime.reviewComplete = false;
  runtime.collapseAnchorId = Option.none();
};

/** Minimal entry shape for session restoration. */
interface SessionEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

/**
 * Scan session entries and restore gate config and last clean SHA.
 *
 * @param runtime - The runtime state to populate.
 * @param entries - The session entries to scan.
 */
const restoreFromEntries = (runtime: RuntimeState, entries: readonly SessionEntryLike[]): void => {
  for (const entry of entries) {
    if (entry.type !== "custom") {
      // eslint-disable-next-line no-continue -- Skip non-custom entries early
      continue;
    }

    if (entry.customType === ENTRY_TYPE_GATES) {
      runtime.gateConfig = restoreGateConfig(entry.data);
    }

    if (entry.customType === ENTRY_TYPE_COMMIT) {
      const restored = restoreCommitSHA(entry.data);

      if (Option.isSome(restored)) {
        runtime.lastCleanCommitSHA = restored;
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Extension Entry Point
// ---------------------------------------------------------------------------

/**
 * Pi extension factory function.
 *
 * @param pi - The pi extension API.
 */
export default function onAgentEnd(pi: ExtensionAPI): void {
  const runtime = createInitialRuntimeState();

  pi.on("session_start", async (_event, ctx) => {
    resetRuntimeState(runtime);
    restoreFromEntries(runtime, ctx.sessionManager.getEntries());
    runtime.cleanup = transition(runtime.cleanup, TransitionEvent.SessionStarted());
    updateStatus(ctx, runtime.cleanup);

    if (Option.isNone(runtime.lastCleanCommitSHA)) {
      const result = await pi.exec("git", ["rev-parse", "HEAD"]);
      const headEither = decodeCommitSHA(result.stdout.trim());

      if (Either.isRight(headEither)) {
        runtime.lastCleanCommitSHA = Option.some(headEither.right);
      }
    }
  });

  // Reset the cleanup cycle when a new user-initiated prompt starts.
  // Extension-injected messages (sendUserMessage) have source "extension"
  // And should not reset the cycle.
  pi.on("input", (event) => {
    if (event.source !== "extension" && runtime.cycleComplete) {
      runtime.cycleComplete = false;
      runtime.evalPending = false;
      runtime.reviewPending = false;
      runtime.reviewComplete = false;
      runtime.cycleActions = [];
    }
  });

  pi.on("tool_call", (event) => {
    if (MUTATION_TOOLS.has(event.toolName)) {
      runtime.mutationDetected = true;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    await handleAgentEnd(pi, runtime, ctx);
  });

  registerGatesCommand(pi, runtime);
  registerCleanupCommand(pi, runtime);
}

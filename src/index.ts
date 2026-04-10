/**
 * Cleanup extension for pi.
 *
 * Hooks into `agent_end` to ensure the repository is clean and
 * well-structured after each agent interaction. Commits uncommitted
 * work, runs quality gates, and ensures commits are atomic.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Option } from "effect";

import { registerCleanupCommand, registerGatesCommand } from "./commands.js";
import { ENTRY_TYPE_COMMIT, ENTRY_TYPE_GATES } from "./persistence.js";
import { handleAgentEnd } from "./pipeline.js";
import { restoreCommitSHA, restoreGateConfig } from "./restore.js";
import { type RuntimeState, createInitialRuntimeState } from "./runtime.js";
import { INITIAL_STATE, TransitionEvent, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";

// ---------------------------------------------------------------------------
// Boomerang Coexistence
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var -- Must be var for global declaration
  var __boomerangCollapseInProgress: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Session Restoration Helpers
// ---------------------------------------------------------------------------

/**
 * Reset runtime state to initial values.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state to reset.
 */
const resetRuntimeState = (pi: ExtensionAPI, runtime: RuntimeState): void => {
  runtime.cleanup = INITIAL_STATE;
  runtime.gateConfig = Option.none();
  runtime.lastCleanCommitSHA = Option.none();
  runtime.boomerangAnchorSet = false;
  runtime.boomerangAvailable = pi.getAllTools().some((tool) => tool.name === "boomerang");
  runtime.evalPending = false;
  runtime.cycleComplete = false;
  runtime.cycleActions = [];
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

/**
 * Notify user of startup warnings.
 *
 * @param runtime - The runtime state.
 * @param ctx - The extension context.
 */
const notifyStartupWarnings = (runtime: RuntimeState, ctx: ExtensionContext): void => {
  if (!runtime.boomerangAvailable) {
    ctx.ui.notify(
      "Boomerang not detected. Cleanup will work but won't collapse context.",
      "warning",
    );
  }

  if (Option.isNone(runtime.gateConfig)) {
    ctx.ui.notify("No quality gates configured. Use /gates to set up.", "warning");
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

  pi.on("session_start", (_event, ctx) => {
    resetRuntimeState(pi, runtime);
    restoreFromEntries(runtime, ctx.sessionManager.getEntries());
    runtime.cleanup = transition(runtime.cleanup, TransitionEvent.SessionStarted());
    updateStatus(ctx, runtime.cleanup);
    notifyStartupWarnings(runtime, ctx);
  });

  // Reset the cleanup cycle when a new user-initiated prompt starts.
  // Extension-injected messages (sendUserMessage) have source "extension"
  // And should not reset the cycle.
  pi.on("input", (event) => {
    if (event.source !== "extension" && runtime.cycleComplete) {
      runtime.cycleComplete = false;
      runtime.evalPending = false;
      runtime.cycleActions = [];
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    await handleAgentEnd(pi, runtime, ctx);
  });

  registerGatesCommand(pi, runtime);
  registerCleanupCommand(pi, runtime);
}

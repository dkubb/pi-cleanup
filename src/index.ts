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
import { Either, Option } from "effect";

import { registerCleanupCommand, registerGatesCommand } from "./commands.js";
import { warn } from "./logger.js";
import { captureCollapseAnchor } from "./pipeline-collapse.js";
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
const FILE_MUTATING_TOOLS = new Set(["bash", "edit", "write"]);

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
  runtime.pluginVersion = Option.none();
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
      const result = restoreGateConfig(entry.data);

      if (Either.isRight(result)) {
        runtime.gateConfig = Option.some(result.right);
      } else if (result.left._tag === "InvalidCommand") {
        warn(
          "restoreFromEntries",
          `discarding gate entry with invalid command (raw=${JSON.stringify(result.left.raw)?.slice(0, 80) ?? "undefined"})`,
        );
      }
    }

    if (entry.customType === ENTRY_TYPE_COMMIT) {
      const result = restoreCommitSHA(entry.data);

      if (Either.isRight(result)) {
        runtime.lastCleanCommitSHA = Option.some(result.right);
      } else if (result.left._tag === "InvalidSHA") {
        warn(
          "restoreFromEntries",
          `invalid CommitSHA in persisted entry (raw="${result.left.raw.slice(0, 80)}")`,
        );
      }
    }
  }
};

/**
 * Reset cycle bookkeeping after a completed cleanup run.
 *
 * @param runtime - The runtime state to reset.
 */
const resetCompletedCycle = (runtime: RuntimeState): void => {
  if (!runtime.cycleComplete) {
    return;
  }

  runtime.cycleComplete = false;
  runtime.evalPending = false;
  runtime.reviewPending = false;
  runtime.reviewComplete = false;
  runtime.cycleActions = [];
};

/**
 * Capture a fresh collapse anchor for a new user-initiated task.
 *
 * @param runtime - The runtime state to update.
 * @param ctx - The extension context for session access.
 */
const recaptureCollapseAnchor = (runtime: RuntimeState, ctx: ExtensionContext): void => {
  runtime.collapseAnchorId = Option.none();
  captureCollapseAnchor(runtime, ctx);
};

const capturePluginVersion = async (pi: ExtensionAPI, runtime: RuntimeState): Promise<void> => {
  try {
    const shaResult = await pi.exec("git", ["rev-parse", "--short", "HEAD"]);

    if (shaResult.code === 0) {
      const trimmed = shaResult.stdout.trim();

      if (trimmed.length > 0) {
        runtime.pluginVersion = Option.some(trimmed);
      } else {
        warn(
          "session_start",
          "failed to capture plugin version (git rev-parse returned empty stdout)",
        );
      }
    } else {
      warn(
        "session_start",
        `failed to capture plugin version (git rev-parse exit=${String(shaResult.code)}, stderr="${shaResult.stderr.slice(0, 80)}")`,
      );
    }
  } catch (error) {
    warn("session_start", `failed to capture plugin version (${String(error)})`);
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
    await capturePluginVersion(pi, runtime);

    if (Option.isNone(runtime.lastCleanCommitSHA)) {
      const result = await pi.exec("git", ["rev-parse", "HEAD"]);
      const headEither = decodeCommitSHA(result.stdout.trim());

      if (Either.isRight(headEither)) {
        runtime.lastCleanCommitSHA = Option.some(headEither.right);
      } else {
        warn(
          "session_start",
          `failed to parse HEAD SHA (git rev-parse exit=${String(result.code)}, stdout="${result.stdout.slice(0, 80)}")`,
        );
      }
    }
  });

  // Reset the cleanup cycle when a new user-initiated prompt starts.
  // Extension-injected messages (sendUserMessage) have source "extension"
  // And should not reset the cycle.
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") {
      recaptureCollapseAnchor(runtime, ctx);
      resetCompletedCycle(runtime);
    }
  });

  pi.on("tool_call", (event) => {
    if (FILE_MUTATING_TOOLS.has(event.toolName)) {
      runtime.mutationDetected = true;
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    await handleAgentEnd(pi, runtime, ctx);
  });

  registerGatesCommand(pi, runtime);
  registerCleanupCommand(pi, runtime);
}

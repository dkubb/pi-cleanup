/**
 * Collapse helpers for the cleanup pipeline.
 *
 * Supports the navigateTree-based cycle collapse: captures an anchor
 * entry ID before the first cleanup message, formats the cycle action
 * summary, and invokes navigateTree via a stored command context.
 *
 * @module
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Option } from "effect";

import type { RuntimeState } from "./runtime.js";

/**
 * Capture the current leaf entry ID as the collapse anchor.
 *
 * Called before the first cleanup message of a cycle so that
 * `navigateTree` can collapse back to this point after completion.
 *
 * @param runtime - The mutable runtime state.
 * @param ctx - The extension context for session access.
 */
export const captureCollapseAnchor = (runtime: RuntimeState, ctx: ExtensionContext): void => {
  if (Option.isSome(runtime.collapseAnchorId)) {
    return;
  }

  const leafId = ctx.sessionManager.getLeafId();

  if (leafId !== null) {
    runtime.collapseAnchorId = Option.some(leafId);
  }
};

/**
 * Format the list of actions taken during the cleanup cycle.
 *
 * @param actions - The raw action strings.
 * @returns Formatted bullet list, or a default message.
 */
export const formatCycleActions = (actions: readonly string[]): string => {
  if (actions.length > 0) {
    return actions.map((a) => `- ${a}`).join("\n");
  }

  return "- No fixes needed (all checks passed on first evaluation)";
};

/**
 * Collapse cleanup context via navigateTree if an anchor is set.
 *
 * Navigates back to the anchor entry ID captured at the start of
 * the cleanup cycle, summarizing all cleanup turns in between.
 * Requires a stored command context with navigateTree access.
 *
 * @param runtime - The mutable runtime state.
 * @returns True if collapse was performed, false otherwise.
 */
export const collapseIfNeeded = async (runtime: RuntimeState): Promise<boolean> => {
  if (Option.isNone(runtime.collapseAnchorId) || Option.isNone(runtime.commandCtx)) {
    return false;
  }

  const anchorId = runtime.collapseAnchorId.value;
  const commandCtx = runtime.commandCtx.value;

  runtime.collapseAnchorId = Option.none();

  await commandCtx.navigateTree(anchorId, {
    customInstructions: ["Cleanup cycle summary:", formatCycleActions(runtime.cycleActions)].join(
      "\n",
    ),
    summarize: true,
  });

  return true;
};

/**
 * Status widget for the cleanup extension.
 *
 * Renders the current cleanup state as a footer status indicator
 * using pi's `ctx.ui.setStatus` API. Uses exhaustive pattern matching
 * to ensure every state variant is handled.
 *
 * @module
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { CleanupState } from "./state-machine.js";

// ---------------------------------------------------------------------------
// Status Widget
// ---------------------------------------------------------------------------

/** Key used with `ctx.ui.setStatus` to identify this extension's indicator. */
export const STATUS_KEY = "cleanup" as const;

/**
 * Update the footer status indicator to reflect the current cleanup state.
 *
 * Uses `Match.exhaustive` on the CleanupState tagged enum — adding a
 * new variant without handling it here produces a compile error.
 *
 * - `Idle`: clears the indicator (passes `undefined`).
 * - `WaitingFor*`: shows a warning-colored progress message with attempt count.
 * - `AwaitingUserInput`: shows a muted "stalled" message.
 * - `Disabled`: shows a muted "off" message.
 *
 * @param _ctx - The extension context (provides `ui.setStatus` and `ui.theme`).
 * @param _state - The current cleanup state to render.
 *
 * @example
 * ```ts
 * // Idle clears the status
 * updateStatus(ctx, CleanupState.Idle());
 * // ctx.ui.setStatus("cleanup", undefined) was called
 *
 * // Waiting shows progress
 * updateStatus(ctx, CleanupState.WaitingForTreeFix({ attempts: attemptCount(2) }));
 * // ctx.ui.setStatus("cleanup", "🔧 dirty tree (attempt 2)") was called
 * ```
 */
export const updateStatus = (_ctx: ExtensionContext, _state: CleanupState): void => {
  // What: Render the cleanup state as a footer status indicator.
  // Why: Gives the user visibility into what the cleanup extension is doing
  //      Without cluttering the main conversation.
  // How: import { Match } from "effect";
  //      Match.value(state).pipe(
  //        Match.tag("Idle", () => undefined),
  //        Match.tag("WaitingForTreeFix", (s) =>
  //          Ctx.ui.theme.fg("warning", `🔧 dirty tree (attempt ${s.attempts})`)),
  //        Match.tag("WaitingForGateFix", (s) =>
  //          Ctx.ui.theme.fg("warning", `🔧 gate failed (attempt ${s.attempts})`)),
  //        Match.tag("WaitingForFactoring", (s) =>
  //          Ctx.ui.theme.fg("warning", `🔧 factoring (attempt ${s.attempts})`)),
  //        Match.tag("AwaitingUserInput", () =>
  //          Ctx.ui.theme.fg("muted", "⏸ cleanup stalled")),
  //        Match.tag("Disabled", () =>
  //          Ctx.ui.theme.fg("muted", "cleanup off")),
  //        Match.exhaustive,
  //      );
  //      Then: ctx.ui.setStatus(STATUS_KEY, text);

  // TODO: Implement
  throw new Error("Not implemented");
};

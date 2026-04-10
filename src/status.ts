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
import { Match } from "effect";

import type { CleanupState } from "./state-machine.js";
import type { AwaitingReason } from "./types.js";

// ---------------------------------------------------------------------------
// Status Widget
// ---------------------------------------------------------------------------

/** Key used with `ctx.ui.setStatus` to identify this extension's indicator. */
export const STATUS_KEY = "cleanup" as const;

/**
 * Format the status text for an AwaitingUserInput state.
 *
 * @param ctx - The extension context for theming.
 * @param reason - The awaiting reason variant.
 * @returns Themed status text.
 */
const formatAwaitingStatus = (ctx: ExtensionContext, reason: AwaitingReason): string =>
  Match.value(reason).pipe(
    Match.tag("BoomerangMissing", (): string => ctx.ui.theme.fg("error", "⛔ boomerang required")),
    Match.tag("GatesUnconfigured", (): string => ctx.ui.theme.fg("muted", "⏸ cleanup stalled")),
    Match.tag("Stalled", (): string => ctx.ui.theme.fg("muted", "⏸ cleanup stalled")),
    Match.exhaustive,
  );

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
 * @param ctx - The extension context (provides `ui.setStatus` and `ui.theme`).
 * @param state - The current cleanup state to render.
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
export const updateStatus = (ctx: ExtensionContext, state: CleanupState): void => {
  const text: string | undefined = Match.value(state).pipe(
    Match.tag("Idle", (): undefined => undefined),
    Match.tag("WaitingForTreeFix", (s): string =>
      ctx.ui.theme.fg("warning", `🔧 dirty tree (attempt ${String(s.attempts)})`),
    ),
    Match.tag("WaitingForGateFix", (s): string =>
      ctx.ui.theme.fg("warning", `🔧 gate failed (attempt ${String(s.attempts)})`),
    ),
    Match.tag("WaitingForFactoring", (s): string =>
      ctx.ui.theme.fg("warning", `🔧 factoring (attempt ${String(s.attempts)})`),
    ),
    Match.tag("AwaitingUserInput", (s): string => formatAwaitingStatus(ctx, s.reason)),
    Match.tag("Disabled", (): string => ctx.ui.theme.fg("muted", "cleanup off")),
    Match.exhaustive,
  );

  ctx.ui.setStatus(STATUS_KEY, text);
};

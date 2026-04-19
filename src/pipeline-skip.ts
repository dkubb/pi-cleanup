/**
 * Pipeline skip-reason tagged enum.
 *
 * The `agent_end` pipeline has several reasons it may skip a given
 * invocation (non-actionable state, completed cycle, no observed
 * mutation). A single boolean would fuse these distinct real-world
 * outcomes onto one bit; a tagged enum keeps them distinguishable for
 * logging, testing, and future behavior that may need to care which
 * reason fired.
 *
 * @module
 */

import { Data, Option } from "effect";

import type { RuntimeState } from "./runtime.js";
import { isActionable } from "./state-machine.js";

/**
 * Reasons the pipeline might skip a given `agent_end` entry.
 *
 * Each variant corresponds to a single, distinct runtime condition —
 * no fusion, no silent catch-all.
 */
export type SkipReason = Data.TaggedEnum<{
  /** Current state is not actionable (Disabled / AwaitingUserInput). */
  readonly NotActionable: {};
  /** Cycle already finished; waiting for the next user prompt. */
  readonly CycleComplete: {};
  /** No mutations observed and no cycle in progress — nothing to do. */
  readonly NoMutation: {};
}>;

/** Constructor namespace for {@link SkipReason} variants. */
export const SkipReason = Data.taggedEnum<SkipReason>();

/**
 * Is a cleanup cycle mid-progress (awaiting review or eval)?
 *
 * Pulled into this module because it is one of the inputs to
 * {@link skipReason}. Exported so the orchestrator can still use it
 * directly for other conditions.
 *
 * @param runtime - The runtime state to check.
 * @returns True if a cycle phase is pending.
 */
export const isCycleInProgress = (runtime: RuntimeState): boolean =>
  runtime.reviewPending || runtime.evalPending;

/**
 * Decide whether the pipeline should skip this `agent_end` and why.
 *
 * Allows mid-cycle continuation even without new mutations (review or
 * eval may still be pending). Returns the specific reason when
 * skipping so callers and tests can distinguish each cause.
 *
 * @param runtime - The runtime state to check.
 * @returns Some(reason) when the pipeline should not run; None when
 *   it should proceed.
 */
export const skipReason = (runtime: RuntimeState): Option.Option<SkipReason> => {
  if (!isActionable(runtime.cleanup)) {
    return Option.some(SkipReason.NotActionable());
  }

  if (runtime.cycleComplete) {
    return Option.some(SkipReason.CycleComplete());
  }

  if (!runtime.mutationDetected && !isCycleInProgress(runtime)) {
    return Option.some(SkipReason.NoMutation());
  }

  return Option.none();
};

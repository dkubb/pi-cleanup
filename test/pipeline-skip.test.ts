import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { skipReason, SkipReason } from "../src/pipeline-skip.js";
import { createInitialRuntimeState } from "../src/runtime.js";
import { CleanupState } from "../src/state-machine.js";
import { AwaitingReason } from "../src/types.js";

describe("skipReason", () => {
  it("returns NotActionable when cleanup is Disabled", () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.Disabled();

    expect(skipReason(runtime)).toStrictEqual(Option.some(SkipReason.NotActionable()));
  });

  it("returns NotActionable when cleanup is AwaitingUserInput", () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.AwaitingUserInput({
      reason: AwaitingReason.GatesUnconfigured(),
    });

    expect(skipReason(runtime)).toStrictEqual(Option.some(SkipReason.NotActionable()));
  });

  it("returns CycleComplete when the cycle is already complete", () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.Idle();
    runtime.cycleComplete = true;
    runtime.mutationDetected = false;

    expect(skipReason(runtime)).toStrictEqual(Option.some(SkipReason.CycleComplete()));
  });

  it("returns NoMutation when idle with no mutation and no cycle in progress", () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.Idle();
    runtime.cycleComplete = false;
    runtime.mutationDetected = false;
    runtime.reviewPending = false;
    runtime.evalPending = false;

    expect(skipReason(runtime)).toStrictEqual(Option.some(SkipReason.NoMutation()));
  });

  it("returns None when idle with a detected mutation", () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.Idle();
    runtime.cycleComplete = false;
    runtime.mutationDetected = true;

    expect(skipReason(runtime)).toStrictEqual(Option.none());
  });

  it("returns None when idle mid-cycle with review pending", () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.Idle();
    runtime.cycleComplete = false;
    runtime.mutationDetected = false;
    runtime.reviewPending = true;

    expect(skipReason(runtime)).toStrictEqual(Option.none());
  });
});

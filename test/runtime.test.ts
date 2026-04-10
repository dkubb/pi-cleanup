import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { createInitialRuntimeState } from "../src/runtime.js";
import { INITIAL_STATE } from "../src/state-machine.js";

describe("createInitialRuntimeState", () => {
  it("returns Idle cleanup state", () => {
    const runtime = createInitialRuntimeState();
    expect(runtime.cleanup).toStrictEqual(INITIAL_STATE);
  });

  it("returns None for gateConfig", () => {
    const runtime = createInitialRuntimeState();
    expect(Option.isNone(runtime.gateConfig)).toStrictEqual(true);
  });

  it("returns None for lastCleanCommitSHA", () => {
    const runtime = createInitialRuntimeState();
    expect(Option.isNone(runtime.lastCleanCommitSHA)).toStrictEqual(true);
  });

  it("returns false for boomerangAvailable", () => {
    const runtime = createInitialRuntimeState();
    expect(runtime.boomerangAvailable).toStrictEqual(false);
  });

  it("returns false for boomerangAnchorSet", () => {
    const runtime = createInitialRuntimeState();
    expect(runtime.boomerangAnchorSet).toStrictEqual(false);
  });

  it("returns false for evalPending", () => {
    const runtime = createInitialRuntimeState();
    expect(runtime.evalPending).toStrictEqual(false);
  });

  it("returns false for cycleComplete", () => {
    const runtime = createInitialRuntimeState();
    expect(runtime.cycleComplete).toStrictEqual(false);
  });

  it("returns None for cycleBaseSHA", () => {
    const runtime = createInitialRuntimeState();
    expect(Option.isNone(runtime.cycleBaseSHA)).toStrictEqual(true);
  });

  it("returns empty array for cycleActions", () => {
    const runtime = createInitialRuntimeState();
    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("returns true for mutationDetected", () => {
    const runtime = createInitialRuntimeState();
    expect(runtime.mutationDetected).toStrictEqual(true);
  });
});

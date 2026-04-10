import { describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import {
  CleanupState,
  INITIAL_STATE,
  isActionable,
  transition,
  TransitionEvent,
} from "../src/state-machine.js";
import {
  AttemptCount,
  AwaitingReason,
  decodeAttemptCount,
  decodeCommitSHA,
  decodeGateCommand,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const sha1 = Either.getOrThrow(decodeCommitSHA("a".repeat(40)));
const sha2 = Either.getOrThrow(decodeCommitSHA("b".repeat(40)));
const cmd1 = Either.getOrThrow(decodeGateCommand("npm test"));
const cmd2 = Either.getOrThrow(decodeGateCommand("npm run lint"));
const attempt1 = Schema.decodeUnknownSync(AttemptCount)(1);
const attempt2 = Schema.decodeUnknownSync(AttemptCount)(2);
const attempt3 = Schema.decodeUnknownSync(AttemptCount)(3);

// ---------------------------------------------------------------------------
// INITIAL_STATE
// ---------------------------------------------------------------------------

describe("INITIAL_STATE", () => {
  it("is Idle", () => {
    expect(INITIAL_STATE._tag).toStrictEqual("Idle");
  });
});

// ---------------------------------------------------------------------------
// isActionable
// ---------------------------------------------------------------------------

describe("isActionable", () => {
  it("returns true for Idle", () => {
    expect(isActionable(CleanupState.Idle())).toStrictEqual(true);
  });

  it("returns true for WaitingForTreeFix", () => {
    expect(isActionable(CleanupState.WaitingForTreeFix({ attempts: attempt1 }))).toStrictEqual(true);
  });

  it("returns true for WaitingForGateFix", () => {
    expect(
      isActionable(CleanupState.WaitingForGateFix({ attempts: attempt1, failedGate: cmd1 })),
    ).toStrictEqual(true);
  });

  it("returns true for WaitingForFactoring", () => {
    expect(
      isActionable(CleanupState.WaitingForFactoring({ attempts: attempt1, priorHeadSHA: sha1 })),
    ).toStrictEqual(true);
  });

  it("returns false for AwaitingUserInput", () => {
    expect(
      isActionable(
        CleanupState.AwaitingUserInput({ reason: AwaitingReason.GatesUnconfigured() }),
      ),
    ).toStrictEqual(false);
  });

  it("returns false for Disabled", () => {
    expect(isActionable(CleanupState.Disabled())).toStrictEqual(false);
  });
});

// ---------------------------------------------------------------------------
// transition from Idle
// ---------------------------------------------------------------------------

describe("transition from Idle", () => {
  const idle = CleanupState.Idle();

  it("GitDirty → WaitingForTreeFix(attempts=1)", () => {
    const next = transition(idle, TransitionEvent.GitDirty({ porcelain: "M foo.ts" }));
    expect(next._tag).toStrictEqual("WaitingForTreeFix");
    const nextWTF = next as Extract<CleanupState, { _tag: "WaitingForTreeFix" }>;
    expect(nextWTF.attempts).toStrictEqual(1);
  });

  it("GitClean → Idle", () => {
    expect(transition(idle, TransitionEvent.GitClean())._tag).toStrictEqual("Idle");
  });

  it("NotARepo → Idle", () => {
    expect(transition(idle, TransitionEvent.NotARepo())._tag).toStrictEqual("Idle");
  });

  it("GateFailed → WaitingForGateFix(attempts=1, failedGate)", () => {
    const next = transition(
      idle,
      TransitionEvent.GateFailed({ command: cmd1, output: "error" }),
    );
    expect(next._tag).toStrictEqual("WaitingForGateFix");
    const nextWGF = next as Extract<CleanupState, { _tag: "WaitingForGateFix" }>;
    expect(nextWGF.attempts).toStrictEqual(1);
    expect(nextWGF.failedGate).toStrictEqual(cmd1);
  });

  it("GatesPassed → Idle", () => {
    expect(transition(idle, TransitionEvent.GatesPassed())._tag).toStrictEqual("Idle");
  });

  it("NoGateConfig → AwaitingUserInput(GatesUnconfigured)", () => {
    const next = transition(idle, TransitionEvent.NoGateConfig());
    expect(next._tag).toStrictEqual("AwaitingUserInput");
    const nextAUI = next as Extract<CleanupState, { _tag: "AwaitingUserInput" }>;
    expect(nextAUI.reason._tag).toStrictEqual("GatesUnconfigured");
  });

  it("NeedsFactoring → WaitingForFactoring(attempts=1, priorHeadSHA)", () => {
    const next = transition(
      idle,
      TransitionEvent.NeedsFactoring({ headSHA: sha1, baseSHA: sha2 }),
    );
    expect(next._tag).toStrictEqual("WaitingForFactoring");
    const nextWFF = next as Extract<CleanupState, { _tag: "WaitingForFactoring" }>;
    expect(nextWFF.attempts).toStrictEqual(1);
    expect(nextWFF.priorHeadSHA).toStrictEqual(sha1);
  });

  it("FactoringConverged → Idle", () => {
    expect(
      transition(idle, TransitionEvent.FactoringConverged({ headSHA: sha1 }))._tag,
    ).toStrictEqual("Idle");
  });

  it("Atomic → Idle", () => {
    expect(transition(idle, TransitionEvent.Atomic({ headSHA: sha1 }))._tag).toStrictEqual("Idle");
  });

  it("NoBase → Idle", () => {
    expect(transition(idle, TransitionEvent.NoBase({ headSHA: sha1 }))._tag).toStrictEqual("Idle");
  });

  it("Indeterminate → Idle", () => {
    expect(transition(idle, TransitionEvent.Indeterminate())._tag).toStrictEqual("Idle");
  });

  it("MaxAttemptsExceeded → Idle (Idle has no max)", () => {
    expect(transition(idle, TransitionEvent.MaxAttemptsExceeded())._tag).toStrictEqual("Idle");
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(idle, TransitionEvent.UserDisabled())._tag).toStrictEqual("Disabled");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(idle, TransitionEvent.SessionStarted())._tag).toStrictEqual("Idle");
  });

  it("UserEnabled → Idle (already idle)", () => {
    expect(transition(idle, TransitionEvent.UserEnabled())._tag).toStrictEqual("Idle");
  });

  it("UserResumed → Idle (no-op from idle)", () => {
    expect(transition(idle, TransitionEvent.UserResumed())._tag).toStrictEqual("Idle");
  });

  it("GatesConfigured → Idle (no-op from idle)", () => {
    expect(transition(idle, TransitionEvent.GatesConfigured())._tag).toStrictEqual("Idle");
  });
});

// ---------------------------------------------------------------------------
// transition from WaitingForTreeFix
// ---------------------------------------------------------------------------

describe("transition from WaitingForTreeFix", () => {
  const waiting = CleanupState.WaitingForTreeFix({ attempts: attempt2 });

  it("GitDirty → WaitingForTreeFix(attempts incremented)", () => {
    const next = transition(waiting, TransitionEvent.GitDirty({ porcelain: "M foo.ts" }));
    expect(next._tag).toStrictEqual("WaitingForTreeFix");
    const nextWTF = next as Extract<CleanupState, { _tag: "WaitingForTreeFix" }>;
    expect(nextWTF.attempts).toStrictEqual(3);
  });

  it("GitClean → Idle", () => {
    expect(transition(waiting, TransitionEvent.GitClean())._tag).toStrictEqual("Idle");
  });

  it("NotARepo → Idle", () => {
    expect(transition(waiting, TransitionEvent.NotARepo())._tag).toStrictEqual("Idle");
  });

  it("GateFailed → WaitingForGateFix(attempts incremented)", () => {
    const next = transition(
      waiting,
      TransitionEvent.GateFailed({ command: cmd1, output: "error" }),
    );
    expect(next._tag).toStrictEqual("WaitingForGateFix");
    const nextWGF = next as Extract<CleanupState, { _tag: "WaitingForGateFix" }>;
    expect(nextWGF.attempts).toStrictEqual(3);
    expect(nextWGF.failedGate).toStrictEqual(cmd1);
  });

  it("GatesPassed → Idle", () => {
    expect(transition(waiting, TransitionEvent.GatesPassed())._tag).toStrictEqual("Idle");
  });

  it("NoGateConfig → AwaitingUserInput(GatesUnconfigured)", () => {
    const next = transition(waiting, TransitionEvent.NoGateConfig());
    expect(next._tag).toStrictEqual("AwaitingUserInput");
    const nextAUI = next as Extract<CleanupState, { _tag: "AwaitingUserInput" }>;
    expect(nextAUI.reason._tag).toStrictEqual("GatesUnconfigured");
  });

  it("NeedsFactoring → WaitingForFactoring(attempts incremented)", () => {
    const next = transition(
      waiting,
      TransitionEvent.NeedsFactoring({ headSHA: sha1, baseSHA: sha2 }),
    );
    expect(next._tag).toStrictEqual("WaitingForFactoring");
    const nextWFF = next as Extract<CleanupState, { _tag: "WaitingForFactoring" }>;
    expect(nextWFF.attempts).toStrictEqual(3);
  });

  it("FactoringConverged → Idle", () => {
    expect(
      transition(waiting, TransitionEvent.FactoringConverged({ headSHA: sha1 }))._tag,
    ).toStrictEqual("Idle");
  });

  it("Atomic → Idle", () => {
    expect(transition(waiting, TransitionEvent.Atomic({ headSHA: sha1 }))._tag).toStrictEqual("Idle");
  });

  it("NoBase → Idle", () => {
    expect(transition(waiting, TransitionEvent.NoBase({ headSHA: sha1 }))._tag).toStrictEqual("Idle");
  });

  it("Indeterminate → Idle", () => {
    expect(transition(waiting, TransitionEvent.Indeterminate())._tag).toStrictEqual("Idle");
  });

  it("MaxAttemptsExceeded → AwaitingUserInput(Stalled) with phase and attempts", () => {
    const next = transition(waiting, TransitionEvent.MaxAttemptsExceeded());
    expect(next._tag).toStrictEqual("AwaitingUserInput");
    const nextAUI = next as Extract<CleanupState, { _tag: "AwaitingUserInput" }>;
    expect(nextAUI.reason._tag).toStrictEqual("Stalled");
    const reason = nextAUI.reason as Extract<AwaitingReason, { _tag: "Stalled" }>;
    expect(reason.phase).toStrictEqual("WaitingForTreeFix");
    expect(reason.attempts).toStrictEqual(2);
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(waiting, TransitionEvent.UserDisabled())._tag).toStrictEqual("Disabled");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(waiting, TransitionEvent.SessionStarted())._tag).toStrictEqual("Idle");
  });

  it("UserEnabled → stays WaitingForTreeFix (no-op)", () => {
    const next = transition(waiting, TransitionEvent.UserEnabled());
    expect(next._tag).toStrictEqual("WaitingForTreeFix");
  });

  it("UserResumed → stays WaitingForTreeFix (no-op)", () => {
    const next = transition(waiting, TransitionEvent.UserResumed());
    expect(next._tag).toStrictEqual("WaitingForTreeFix");
  });

  it("GatesConfigured → stays WaitingForTreeFix (no-op)", () => {
    const next = transition(waiting, TransitionEvent.GatesConfigured());
    expect(next._tag).toStrictEqual("WaitingForTreeFix");
  });
});

// ---------------------------------------------------------------------------
// transition from WaitingForGateFix
// ---------------------------------------------------------------------------

describe("transition from WaitingForGateFix", () => {
  const waiting = CleanupState.WaitingForGateFix({ attempts: attempt2, failedGate: cmd1 });

  it("GitDirty → WaitingForTreeFix(attempts incremented)", () => {
    const next = transition(waiting, TransitionEvent.GitDirty({ porcelain: "M foo.ts" }));
    expect(next._tag).toStrictEqual("WaitingForTreeFix");
    const nextWTF = next as Extract<CleanupState, { _tag: "WaitingForTreeFix" }>;
    expect(nextWTF.attempts).toStrictEqual(3);
  });

  it("GitClean → Idle", () => {
    expect(transition(waiting, TransitionEvent.GitClean())._tag).toStrictEqual("Idle");
  });

  it("GateFailed → WaitingForGateFix(attempts incremented, new command)", () => {
    const next = transition(
      waiting,
      TransitionEvent.GateFailed({ command: cmd2, output: "lint error" }),
    );
    expect(next._tag).toStrictEqual("WaitingForGateFix");
    const nextWGF = next as Extract<CleanupState, { _tag: "WaitingForGateFix" }>;
    expect(nextWGF.attempts).toStrictEqual(3);
    expect(nextWGF.failedGate).toStrictEqual(cmd2);
  });

  it("GatesPassed → Idle", () => {
    expect(transition(waiting, TransitionEvent.GatesPassed())._tag).toStrictEqual("Idle");
  });

  it("MaxAttemptsExceeded → AwaitingUserInput(Stalled) with WaitingForGateFix phase", () => {
    const next = transition(waiting, TransitionEvent.MaxAttemptsExceeded());
    expect(next._tag).toStrictEqual("AwaitingUserInput");
    const nextAUI = next as Extract<CleanupState, { _tag: "AwaitingUserInput" }>;
    expect(nextAUI.reason._tag).toStrictEqual("Stalled");
    const reason = nextAUI.reason as Extract<AwaitingReason, { _tag: "Stalled" }>;
    expect(reason.phase).toStrictEqual("WaitingForGateFix");
    expect(reason.attempts).toStrictEqual(2);
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(waiting, TransitionEvent.UserDisabled())._tag).toStrictEqual("Disabled");
  });

  it("UserEnabled → stays WaitingForGateFix (no-op)", () => {
    expect(transition(waiting, TransitionEvent.UserEnabled())._tag).toStrictEqual("WaitingForGateFix");
  });
});

// ---------------------------------------------------------------------------
// transition from WaitingForFactoring
// ---------------------------------------------------------------------------

describe("transition from WaitingForFactoring", () => {
  const waiting = CleanupState.WaitingForFactoring({ attempts: attempt2, priorHeadSHA: sha1 });

  it("NeedsFactoring → WaitingForFactoring(attempts incremented, new head)", () => {
    const next = transition(
      waiting,
      TransitionEvent.NeedsFactoring({ headSHA: sha2, baseSHA: sha1 }),
    );
    expect(next._tag).toStrictEqual("WaitingForFactoring");
    const nextWFF = next as Extract<CleanupState, { _tag: "WaitingForFactoring" }>;
    expect(nextWFF.attempts).toStrictEqual(3);
    expect(nextWFF.priorHeadSHA).toStrictEqual(sha2);
  });

  it("FactoringConverged → Idle", () => {
    expect(
      transition(waiting, TransitionEvent.FactoringConverged({ headSHA: sha1 }))._tag,
    ).toStrictEqual("Idle");
  });

  it("Atomic → Idle", () => {
    expect(transition(waiting, TransitionEvent.Atomic({ headSHA: sha1 }))._tag).toStrictEqual("Idle");
  });

  it("NoBase → Idle", () => {
    expect(transition(waiting, TransitionEvent.NoBase({ headSHA: sha1 }))._tag).toStrictEqual("Idle");
  });

  it("Indeterminate → Idle", () => {
    expect(transition(waiting, TransitionEvent.Indeterminate())._tag).toStrictEqual("Idle");
  });

  it("GateFailed → WaitingForGateFix(attempts incremented)", () => {
    const next = transition(
      waiting,
      TransitionEvent.GateFailed({ command: cmd1, output: "error" }),
    );
    expect(next._tag).toStrictEqual("WaitingForGateFix");
    const nextWGF = next as Extract<CleanupState, { _tag: "WaitingForGateFix" }>;
    expect(nextWGF.attempts).toStrictEqual(3);
  });

  it("MaxAttemptsExceeded → AwaitingUserInput(Stalled) with WaitingForFactoring phase", () => {
    const next = transition(waiting, TransitionEvent.MaxAttemptsExceeded());
    expect(next._tag).toStrictEqual("AwaitingUserInput");
    const nextAUI = next as Extract<CleanupState, { _tag: "AwaitingUserInput" }>;
    expect(nextAUI.reason._tag).toStrictEqual("Stalled");
    const reason = nextAUI.reason as Extract<AwaitingReason, { _tag: "Stalled" }>;
    expect(reason.phase).toStrictEqual("WaitingForFactoring");
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(waiting, TransitionEvent.UserDisabled())._tag).toStrictEqual("Disabled");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(waiting, TransitionEvent.SessionStarted())._tag).toStrictEqual("Idle");
  });
});

// ---------------------------------------------------------------------------
// transition from AwaitingUserInput
// ---------------------------------------------------------------------------

describe("transition from AwaitingUserInput", () => {
  const awaitingGates = CleanupState.AwaitingUserInput({
    reason: AwaitingReason.GatesUnconfigured(),
  });
  const awaitingStalled = CleanupState.AwaitingUserInput({
    reason: AwaitingReason.Stalled({ phase: "WaitingForGateFix", attempts: attempt3 }),
  });

  it("UserResumed → Idle", () => {
    expect(transition(awaitingStalled, TransitionEvent.UserResumed())._tag).toStrictEqual("Idle");
  });

  it("GatesConfigured → Idle", () => {
    expect(transition(awaitingGates, TransitionEvent.GatesConfigured())._tag).toStrictEqual("Idle");
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(awaitingGates, TransitionEvent.UserDisabled())._tag).toStrictEqual("Disabled");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(awaitingGates, TransitionEvent.SessionStarted())._tag).toStrictEqual("Idle");
  });

  it("pipeline events are ignored (stays AwaitingUserInput)", () => {
    const pipelineEvents = [
      TransitionEvent.GitDirty({ porcelain: "M foo.ts" }),
      TransitionEvent.GitClean(),
      TransitionEvent.NotARepo(),
      TransitionEvent.GateFailed({ command: cmd1, output: "error" }),
      TransitionEvent.GatesPassed(),
      TransitionEvent.NoGateConfig(),
      TransitionEvent.NeedsFactoring({ headSHA: sha1, baseSHA: sha2 }),
      TransitionEvent.FactoringConverged({ headSHA: sha1 }),
      TransitionEvent.Atomic({ headSHA: sha1 }),
      TransitionEvent.NoBase({ headSHA: sha1 }),
      TransitionEvent.Indeterminate(),
      TransitionEvent.MaxAttemptsExceeded(),
    ];

    for (const event of pipelineEvents) {
      const next = transition(awaitingGates, event);
      expect(next._tag).toStrictEqual("AwaitingUserInput");
    }
  });

  it("UserEnabled → stays AwaitingUserInput (no-op)", () => {
    expect(transition(awaitingGates, TransitionEvent.UserEnabled())._tag).toStrictEqual(
      "AwaitingUserInput",
    );
  });
});

// ---------------------------------------------------------------------------
// transition from Disabled
// ---------------------------------------------------------------------------

describe("transition from Disabled", () => {
  const disabled = CleanupState.Disabled();

  it("UserEnabled → Idle", () => {
    expect(transition(disabled, TransitionEvent.UserEnabled())._tag).toStrictEqual("Idle");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(disabled, TransitionEvent.SessionStarted())._tag).toStrictEqual("Idle");
  });

  it("pipeline events are ignored (stays Disabled)", () => {
    const pipelineEvents = [
      TransitionEvent.GitDirty({ porcelain: "M foo.ts" }),
      TransitionEvent.GitClean(),
      TransitionEvent.NotARepo(),
      TransitionEvent.GateFailed({ command: cmd1, output: "error" }),
      TransitionEvent.GatesPassed(),
      TransitionEvent.NoGateConfig(),
      TransitionEvent.NeedsFactoring({ headSHA: sha1, baseSHA: sha2 }),
      TransitionEvent.FactoringConverged({ headSHA: sha1 }),
      TransitionEvent.Atomic({ headSHA: sha1 }),
      TransitionEvent.NoBase({ headSHA: sha1 }),
      TransitionEvent.Indeterminate(),
      TransitionEvent.MaxAttemptsExceeded(),
    ];

    for (const event of pipelineEvents) {
      expect(transition(disabled, event)._tag).toStrictEqual("Disabled");
    }
  });

  it("UserDisabled → stays Disabled (no-op)", () => {
    expect(transition(disabled, TransitionEvent.UserDisabled())._tag).toStrictEqual("Disabled");
  });

  it("UserResumed → stays Disabled (no-op)", () => {
    expect(transition(disabled, TransitionEvent.UserResumed())._tag).toStrictEqual("Disabled");
  });

  it("GatesConfigured → stays Disabled (no-op)", () => {
    expect(transition(disabled, TransitionEvent.GatesConfigured())._tag).toStrictEqual("Disabled");
  });
});

// ---------------------------------------------------------------------------
// Multi-step sequences
// ---------------------------------------------------------------------------

describe("multi-step transition sequences", () => {
  it("Idle → GitDirty → GitClean → Idle (tree fix loop)", () => {
    let state = CleanupState.Idle();
    state = transition(state, TransitionEvent.GitDirty({ porcelain: "M foo.ts" }));
    expect(state._tag).toStrictEqual("WaitingForTreeFix");
    state = transition(state, TransitionEvent.GitClean());
    expect(state._tag).toStrictEqual("Idle");
  });

  it("Idle → GateFailed → GatesPassed → Idle (gate fix loop)", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.GateFailed({ command: cmd1, output: "error" }));
    expect(state._tag).toStrictEqual("WaitingForGateFix");
    state = transition(state, TransitionEvent.GatesPassed());
    expect(state._tag).toStrictEqual("Idle");
  });

  it("Idle → UserDisabled → UserEnabled → Idle (enable/disable cycle)", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.UserDisabled());
    expect(state._tag).toStrictEqual("Disabled");
    state = transition(state, TransitionEvent.UserEnabled());
    expect(state._tag).toStrictEqual("Idle");
  });

  it("Idle → NoGateConfig → GatesConfigured → Idle (configure gates)", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.NoGateConfig());
    expect(state._tag).toStrictEqual("AwaitingUserInput");
    state = transition(state, TransitionEvent.GatesConfigured());
    expect(state._tag).toStrictEqual("Idle");
  });

  it("Idle → MaxAttemptsExceeded during WaitingForGateFix → UserResumed → Idle", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.GateFailed({ command: cmd1, output: "error" }));
    state = transition(state, TransitionEvent.MaxAttemptsExceeded());
    expect(state._tag).toStrictEqual("AwaitingUserInput");
    state = transition(state, TransitionEvent.UserResumed());
    expect(state._tag).toStrictEqual("Idle");
  });

  it("SessionStarted resets WaitingForTreeFix to Idle", () => {
    let state: CleanupState = CleanupState.WaitingForTreeFix({ attempts: attempt2 });
    state = transition(state, TransitionEvent.SessionStarted());
    expect(state._tag).toStrictEqual("Idle");
  });

  it("SessionStarted resets Disabled to Idle", () => {
    let state: CleanupState = CleanupState.Disabled();
    state = transition(state, TransitionEvent.SessionStarted());
    expect(state._tag).toStrictEqual("Idle");
  });

  it("attempt counter increments across repeated GitDirty events", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.GitDirty({ porcelain: "M a.ts" }));
    expect(state._tag).toStrictEqual("WaitingForTreeFix");
    const state1 = state as Extract<CleanupState, { _tag: "WaitingForTreeFix" }>;
    expect(state1.attempts).toStrictEqual(1);
    state = transition(state, TransitionEvent.GitDirty({ porcelain: "M a.ts" }));
    expect(state._tag).toStrictEqual("WaitingForTreeFix");
    const state2 = state as Extract<CleanupState, { _tag: "WaitingForTreeFix" }>;
    expect(state2.attempts).toStrictEqual(2);
    state = transition(state, TransitionEvent.GitDirty({ porcelain: "M a.ts" }));
    expect(state._tag).toStrictEqual("WaitingForTreeFix");
    const state3 = state as Extract<CleanupState, { _tag: "WaitingForTreeFix" }>;
    expect(state3.attempts).toStrictEqual(3);
  });
});

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
    expect(INITIAL_STATE._tag).toBe("Idle");
  });
});

// ---------------------------------------------------------------------------
// isActionable
// ---------------------------------------------------------------------------

describe("isActionable", () => {
  it("returns true for Idle", () => {
    expect(isActionable(CleanupState.Idle())).toBe(true);
  });

  it("returns true for WaitingForTreeFix", () => {
    expect(isActionable(CleanupState.WaitingForTreeFix({ attempts: attempt1 }))).toBe(true);
  });

  it("returns true for WaitingForGateFix", () => {
    expect(
      isActionable(CleanupState.WaitingForGateFix({ attempts: attempt1, failedGate: cmd1 })),
    ).toBe(true);
  });

  it("returns true for WaitingForFactoring", () => {
    expect(
      isActionable(CleanupState.WaitingForFactoring({ attempts: attempt1, priorHeadSHA: sha1 })),
    ).toBe(true);
  });

  it("returns false for AwaitingUserInput", () => {
    expect(
      isActionable(
        CleanupState.AwaitingUserInput({ reason: AwaitingReason.GatesUnconfigured() }),
      ),
    ).toBe(false);
  });

  it("returns false for Disabled", () => {
    expect(isActionable(CleanupState.Disabled())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transition from Idle
// ---------------------------------------------------------------------------

describe("transition from Idle", () => {
  const idle = CleanupState.Idle();

  it("GitDirty → WaitingForTreeFix(attempts=1)", () => {
    const next = transition(idle, TransitionEvent.GitDirty({ porcelain: "M foo.ts" }));
    expect(next._tag).toBe("WaitingForTreeFix");
    if (next._tag === "WaitingForTreeFix") {
      expect(next.attempts).toBe(1);
    }
  });

  it("GitClean → Idle", () => {
    expect(transition(idle, TransitionEvent.GitClean())._tag).toBe("Idle");
  });

  it("NotARepo → Idle", () => {
    expect(transition(idle, TransitionEvent.NotARepo())._tag).toBe("Idle");
  });

  it("GateFailed → WaitingForGateFix(attempts=1, failedGate)", () => {
    const next = transition(
      idle,
      TransitionEvent.GateFailed({ command: cmd1, output: "error" }),
    );
    expect(next._tag).toBe("WaitingForGateFix");
    if (next._tag === "WaitingForGateFix") {
      expect(next.attempts).toBe(1);
      expect(next.failedGate).toBe(cmd1);
    }
  });

  it("GatesPassed → Idle", () => {
    expect(transition(idle, TransitionEvent.GatesPassed())._tag).toBe("Idle");
  });

  it("NoGateConfig → AwaitingUserInput(GatesUnconfigured)", () => {
    const next = transition(idle, TransitionEvent.NoGateConfig());
    expect(next._tag).toBe("AwaitingUserInput");
    if (next._tag === "AwaitingUserInput") {
      expect(next.reason._tag).toBe("GatesUnconfigured");
    }
  });

  it("NeedsFactoring → WaitingForFactoring(attempts=1, priorHeadSHA)", () => {
    const next = transition(
      idle,
      TransitionEvent.NeedsFactoring({ headSHA: sha1, baseSHA: sha2 }),
    );
    expect(next._tag).toBe("WaitingForFactoring");
    if (next._tag === "WaitingForFactoring") {
      expect(next.attempts).toBe(1);
      expect(next.priorHeadSHA).toBe(sha1);
    }
  });

  it("FactoringConverged → Idle", () => {
    expect(
      transition(idle, TransitionEvent.FactoringConverged({ headSHA: sha1 }))._tag,
    ).toBe("Idle");
  });

  it("Atomic → Idle", () => {
    expect(transition(idle, TransitionEvent.Atomic({ headSHA: sha1 }))._tag).toBe("Idle");
  });

  it("NoBase → Idle", () => {
    expect(transition(idle, TransitionEvent.NoBase({ headSHA: sha1 }))._tag).toBe("Idle");
  });

  it("Indeterminate → Idle", () => {
    expect(transition(idle, TransitionEvent.Indeterminate())._tag).toBe("Idle");
  });

  it("MaxAttemptsExceeded → Idle (Idle has no max)", () => {
    expect(transition(idle, TransitionEvent.MaxAttemptsExceeded())._tag).toBe("Idle");
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(idle, TransitionEvent.UserDisabled())._tag).toBe("Disabled");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(idle, TransitionEvent.SessionStarted())._tag).toBe("Idle");
  });

  it("UserEnabled → Idle (already idle)", () => {
    expect(transition(idle, TransitionEvent.UserEnabled())._tag).toBe("Idle");
  });

  it("UserResumed → Idle (no-op from idle)", () => {
    expect(transition(idle, TransitionEvent.UserResumed())._tag).toBe("Idle");
  });

  it("GatesConfigured → Idle (no-op from idle)", () => {
    expect(transition(idle, TransitionEvent.GatesConfigured())._tag).toBe("Idle");
  });
});

// ---------------------------------------------------------------------------
// transition from WaitingForTreeFix
// ---------------------------------------------------------------------------

describe("transition from WaitingForTreeFix", () => {
  const waiting = CleanupState.WaitingForTreeFix({ attempts: attempt2 });

  it("GitDirty → WaitingForTreeFix(attempts incremented)", () => {
    const next = transition(waiting, TransitionEvent.GitDirty({ porcelain: "M foo.ts" }));
    expect(next._tag).toBe("WaitingForTreeFix");
    if (next._tag === "WaitingForTreeFix") {
      expect(next.attempts).toBe(3);
    }
  });

  it("GitClean → Idle", () => {
    expect(transition(waiting, TransitionEvent.GitClean())._tag).toBe("Idle");
  });

  it("NotARepo → Idle", () => {
    expect(transition(waiting, TransitionEvent.NotARepo())._tag).toBe("Idle");
  });

  it("GateFailed → WaitingForGateFix(attempts incremented)", () => {
    const next = transition(
      waiting,
      TransitionEvent.GateFailed({ command: cmd1, output: "error" }),
    );
    expect(next._tag).toBe("WaitingForGateFix");
    if (next._tag === "WaitingForGateFix") {
      expect(next.attempts).toBe(3);
      expect(next.failedGate).toBe(cmd1);
    }
  });

  it("GatesPassed → Idle", () => {
    expect(transition(waiting, TransitionEvent.GatesPassed())._tag).toBe("Idle");
  });

  it("NoGateConfig → AwaitingUserInput(GatesUnconfigured)", () => {
    const next = transition(waiting, TransitionEvent.NoGateConfig());
    expect(next._tag).toBe("AwaitingUserInput");
    if (next._tag === "AwaitingUserInput") {
      expect(next.reason._tag).toBe("GatesUnconfigured");
    }
  });

  it("NeedsFactoring → WaitingForFactoring(attempts incremented)", () => {
    const next = transition(
      waiting,
      TransitionEvent.NeedsFactoring({ headSHA: sha1, baseSHA: sha2 }),
    );
    expect(next._tag).toBe("WaitingForFactoring");
    if (next._tag === "WaitingForFactoring") {
      expect(next.attempts).toBe(3);
    }
  });

  it("FactoringConverged → Idle", () => {
    expect(
      transition(waiting, TransitionEvent.FactoringConverged({ headSHA: sha1 }))._tag,
    ).toBe("Idle");
  });

  it("Atomic → Idle", () => {
    expect(transition(waiting, TransitionEvent.Atomic({ headSHA: sha1 }))._tag).toBe("Idle");
  });

  it("NoBase → Idle", () => {
    expect(transition(waiting, TransitionEvent.NoBase({ headSHA: sha1 }))._tag).toBe("Idle");
  });

  it("Indeterminate → Idle", () => {
    expect(transition(waiting, TransitionEvent.Indeterminate())._tag).toBe("Idle");
  });

  it("MaxAttemptsExceeded → AwaitingUserInput(Stalled) with phase and attempts", () => {
    const next = transition(waiting, TransitionEvent.MaxAttemptsExceeded());
    expect(next._tag).toBe("AwaitingUserInput");
    if (next._tag === "AwaitingUserInput") {
      expect(next.reason._tag).toBe("Stalled");
      if (next.reason._tag === "Stalled") {
        expect(next.reason.phase).toBe("WaitingForTreeFix");
        expect(next.reason.attempts).toBe(2);
      }
    }
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(waiting, TransitionEvent.UserDisabled())._tag).toBe("Disabled");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(waiting, TransitionEvent.SessionStarted())._tag).toBe("Idle");
  });

  it("UserEnabled → stays WaitingForTreeFix (no-op)", () => {
    const next = transition(waiting, TransitionEvent.UserEnabled());
    expect(next._tag).toBe("WaitingForTreeFix");
  });

  it("UserResumed → stays WaitingForTreeFix (no-op)", () => {
    const next = transition(waiting, TransitionEvent.UserResumed());
    expect(next._tag).toBe("WaitingForTreeFix");
  });

  it("GatesConfigured → stays WaitingForTreeFix (no-op)", () => {
    const next = transition(waiting, TransitionEvent.GatesConfigured());
    expect(next._tag).toBe("WaitingForTreeFix");
  });
});

// ---------------------------------------------------------------------------
// transition from WaitingForGateFix
// ---------------------------------------------------------------------------

describe("transition from WaitingForGateFix", () => {
  const waiting = CleanupState.WaitingForGateFix({ attempts: attempt2, failedGate: cmd1 });

  it("GitDirty → WaitingForTreeFix(attempts incremented)", () => {
    const next = transition(waiting, TransitionEvent.GitDirty({ porcelain: "M foo.ts" }));
    expect(next._tag).toBe("WaitingForTreeFix");
    if (next._tag === "WaitingForTreeFix") {
      expect(next.attempts).toBe(3);
    }
  });

  it("GitClean → Idle", () => {
    expect(transition(waiting, TransitionEvent.GitClean())._tag).toBe("Idle");
  });

  it("GateFailed → WaitingForGateFix(attempts incremented, new command)", () => {
    const next = transition(
      waiting,
      TransitionEvent.GateFailed({ command: cmd2, output: "lint error" }),
    );
    expect(next._tag).toBe("WaitingForGateFix");
    if (next._tag === "WaitingForGateFix") {
      expect(next.attempts).toBe(3);
      expect(next.failedGate).toBe(cmd2);
    }
  });

  it("GatesPassed → Idle", () => {
    expect(transition(waiting, TransitionEvent.GatesPassed())._tag).toBe("Idle");
  });

  it("MaxAttemptsExceeded → AwaitingUserInput(Stalled) with WaitingForGateFix phase", () => {
    const next = transition(waiting, TransitionEvent.MaxAttemptsExceeded());
    expect(next._tag).toBe("AwaitingUserInput");
    if (next._tag === "AwaitingUserInput") {
      expect(next.reason._tag).toBe("Stalled");
      if (next.reason._tag === "Stalled") {
        expect(next.reason.phase).toBe("WaitingForGateFix");
        expect(next.reason.attempts).toBe(2);
      }
    }
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(waiting, TransitionEvent.UserDisabled())._tag).toBe("Disabled");
  });

  it("UserEnabled → stays WaitingForGateFix (no-op)", () => {
    expect(transition(waiting, TransitionEvent.UserEnabled())._tag).toBe("WaitingForGateFix");
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
    expect(next._tag).toBe("WaitingForFactoring");
    if (next._tag === "WaitingForFactoring") {
      expect(next.attempts).toBe(3);
      expect(next.priorHeadSHA).toBe(sha2);
    }
  });

  it("FactoringConverged → Idle", () => {
    expect(
      transition(waiting, TransitionEvent.FactoringConverged({ headSHA: sha1 }))._tag,
    ).toBe("Idle");
  });

  it("Atomic → Idle", () => {
    expect(transition(waiting, TransitionEvent.Atomic({ headSHA: sha1 }))._tag).toBe("Idle");
  });

  it("NoBase → Idle", () => {
    expect(transition(waiting, TransitionEvent.NoBase({ headSHA: sha1 }))._tag).toBe("Idle");
  });

  it("Indeterminate → Idle", () => {
    expect(transition(waiting, TransitionEvent.Indeterminate())._tag).toBe("Idle");
  });

  it("GateFailed → WaitingForGateFix(attempts incremented)", () => {
    const next = transition(
      waiting,
      TransitionEvent.GateFailed({ command: cmd1, output: "error" }),
    );
    expect(next._tag).toBe("WaitingForGateFix");
    if (next._tag === "WaitingForGateFix") {
      expect(next.attempts).toBe(3);
    }
  });

  it("MaxAttemptsExceeded → AwaitingUserInput(Stalled) with WaitingForFactoring phase", () => {
    const next = transition(waiting, TransitionEvent.MaxAttemptsExceeded());
    expect(next._tag).toBe("AwaitingUserInput");
    if (next._tag === "AwaitingUserInput") {
      expect(next.reason._tag).toBe("Stalled");
      if (next.reason._tag === "Stalled") {
        expect(next.reason.phase).toBe("WaitingForFactoring");
      }
    }
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(waiting, TransitionEvent.UserDisabled())._tag).toBe("Disabled");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(waiting, TransitionEvent.SessionStarted())._tag).toBe("Idle");
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
    expect(transition(awaitingStalled, TransitionEvent.UserResumed())._tag).toBe("Idle");
  });

  it("GatesConfigured → Idle", () => {
    expect(transition(awaitingGates, TransitionEvent.GatesConfigured())._tag).toBe("Idle");
  });

  it("UserDisabled → Disabled", () => {
    expect(transition(awaitingGates, TransitionEvent.UserDisabled())._tag).toBe("Disabled");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(awaitingGates, TransitionEvent.SessionStarted())._tag).toBe("Idle");
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
      expect(next._tag).toBe("AwaitingUserInput");
    }
  });

  it("UserEnabled → stays AwaitingUserInput (no-op)", () => {
    expect(transition(awaitingGates, TransitionEvent.UserEnabled())._tag).toBe(
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
    expect(transition(disabled, TransitionEvent.UserEnabled())._tag).toBe("Idle");
  });

  it("SessionStarted → Idle", () => {
    expect(transition(disabled, TransitionEvent.SessionStarted())._tag).toBe("Idle");
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
      expect(transition(disabled, event)._tag).toBe("Disabled");
    }
  });

  it("UserDisabled → stays Disabled (no-op)", () => {
    expect(transition(disabled, TransitionEvent.UserDisabled())._tag).toBe("Disabled");
  });

  it("UserResumed → stays Disabled (no-op)", () => {
    expect(transition(disabled, TransitionEvent.UserResumed())._tag).toBe("Disabled");
  });

  it("GatesConfigured → stays Disabled (no-op)", () => {
    expect(transition(disabled, TransitionEvent.GatesConfigured())._tag).toBe("Disabled");
  });
});

// ---------------------------------------------------------------------------
// Multi-step sequences
// ---------------------------------------------------------------------------

describe("multi-step transition sequences", () => {
  it("Idle → GitDirty → GitClean → Idle (tree fix loop)", () => {
    let state = CleanupState.Idle();
    state = transition(state, TransitionEvent.GitDirty({ porcelain: "M foo.ts" }));
    expect(state._tag).toBe("WaitingForTreeFix");
    state = transition(state, TransitionEvent.GitClean());
    expect(state._tag).toBe("Idle");
  });

  it("Idle → GateFailed → GatesPassed → Idle (gate fix loop)", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.GateFailed({ command: cmd1, output: "error" }));
    expect(state._tag).toBe("WaitingForGateFix");
    state = transition(state, TransitionEvent.GatesPassed());
    expect(state._tag).toBe("Idle");
  });

  it("Idle → UserDisabled → UserEnabled → Idle (enable/disable cycle)", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.UserDisabled());
    expect(state._tag).toBe("Disabled");
    state = transition(state, TransitionEvent.UserEnabled());
    expect(state._tag).toBe("Idle");
  });

  it("Idle → NoGateConfig → GatesConfigured → Idle (configure gates)", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.NoGateConfig());
    expect(state._tag).toBe("AwaitingUserInput");
    state = transition(state, TransitionEvent.GatesConfigured());
    expect(state._tag).toBe("Idle");
  });

  it("Idle → MaxAttemptsExceeded during WaitingForGateFix → UserResumed → Idle", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.GateFailed({ command: cmd1, output: "error" }));
    state = transition(state, TransitionEvent.MaxAttemptsExceeded());
    expect(state._tag).toBe("AwaitingUserInput");
    state = transition(state, TransitionEvent.UserResumed());
    expect(state._tag).toBe("Idle");
  });

  it("SessionStarted resets WaitingForTreeFix to Idle", () => {
    let state: CleanupState = CleanupState.WaitingForTreeFix({ attempts: attempt2 });
    state = transition(state, TransitionEvent.SessionStarted());
    expect(state._tag).toBe("Idle");
  });

  it("SessionStarted resets Disabled to Idle", () => {
    let state: CleanupState = CleanupState.Disabled();
    state = transition(state, TransitionEvent.SessionStarted());
    expect(state._tag).toBe("Idle");
  });

  it("attempt counter increments across repeated GitDirty events", () => {
    let state: CleanupState = CleanupState.Idle();
    state = transition(state, TransitionEvent.GitDirty({ porcelain: "M a.ts" }));
    expect(state._tag === "WaitingForTreeFix" && state.attempts).toBe(1);
    state = transition(state, TransitionEvent.GitDirty({ porcelain: "M a.ts" }));
    expect(state._tag === "WaitingForTreeFix" && state.attempts).toBe(2);
    state = transition(state, TransitionEvent.GitDirty({ porcelain: "M a.ts" }));
    expect(state._tag === "WaitingForTreeFix" && state.attempts).toBe(3);
  });
});

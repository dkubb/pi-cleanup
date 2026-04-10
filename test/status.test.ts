import { describe, expect, it, vi } from "vitest";
import { Either, Schema } from "effect";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { STATUS_KEY, updateStatus } from "../src/status.js";
import { CleanupState } from "../src/state-machine.js";
import {
  AttemptCount,
  AwaitingReason,
  decodeCommitSHA,
  decodeGateCommand,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const attempt = (n: number): AttemptCount => Schema.decodeUnknownSync(AttemptCount)(n);
const sha = Either.getOrThrow(decodeCommitSHA("a".repeat(40)));
const cmd = Either.getOrThrow(decodeGateCommand("npm test"));

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock ExtensionContext with spies on setStatus and theme.fg.
 * theme.fg returns a tagged string so assertions can inspect role + text.
 */
const makeCtx = (): {
  ctx: ExtensionContext;
  setStatus: ReturnType<typeof vi.fn>;
  themeFg: ReturnType<typeof vi.fn>;
} => {
  const setStatus = vi.fn();
  const themeFg = vi.fn((role: string, text: string) => `[${role}]${text}`);

  const ctx = {
    ui: {
      setStatus,
      theme: {
        fg: themeFg,
      },
    },
  } as unknown as ExtensionContext;

  return { ctx, setStatus, themeFg };
};

// ---------------------------------------------------------------------------
// updateStatus — Idle
// ---------------------------------------------------------------------------

describe("updateStatus — Idle", () => {
  it("calls setStatus with STATUS_KEY and undefined", () => {
    const { ctx, setStatus } = makeCtx();

    updateStatus(ctx, CleanupState.Idle());

    expect(setStatus).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, undefined);
  });

  it("does not call theme.fg", () => {
    const { ctx, themeFg } = makeCtx();

    updateStatus(ctx, CleanupState.Idle());

    expect(themeFg).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateStatus — WaitingForTreeFix
// ---------------------------------------------------------------------------

describe("updateStatus — WaitingForTreeFix", () => {
  it("calls setStatus with a warning-colored dirty-tree message", () => {
    const { ctx, setStatus, themeFg } = makeCtx();

    updateStatus(ctx, CleanupState.WaitingForTreeFix({ attempts: attempt(1) }));

    expect(themeFg).toHaveBeenCalledWith("warning", expect.stringContaining("dirty tree"));
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, expect.stringContaining("warning"));
  });

  it("includes the attempt count in the status text (attempt 1)", () => {
    const { ctx, setStatus } = makeCtx();

    updateStatus(ctx, CleanupState.WaitingForTreeFix({ attempts: attempt(1) }));

    const [, text] = setStatus.mock.calls[0] as [string, string];
    expect(text).toContain("1");
  });

  it("includes the attempt count in the status text (attempt 3)", () => {
    const { ctx, setStatus } = makeCtx();

    updateStatus(ctx, CleanupState.WaitingForTreeFix({ attempts: attempt(3) }));

    const [, text] = setStatus.mock.calls[0] as [string, string];
    expect(text).toContain("3");
  });
});

// ---------------------------------------------------------------------------
// updateStatus — WaitingForGateFix
// ---------------------------------------------------------------------------

describe("updateStatus — WaitingForGateFix", () => {
  it("calls setStatus with a warning-colored gate-failed message", () => {
    const { ctx, setStatus, themeFg } = makeCtx();

    updateStatus(ctx, CleanupState.WaitingForGateFix({ attempts: attempt(2), failedGate: cmd }));

    expect(themeFg).toHaveBeenCalledWith("warning", expect.stringContaining("gate failed"));
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, expect.stringContaining("warning"));
  });

  it("includes the attempt count in the status text", () => {
    const { ctx, setStatus } = makeCtx();

    updateStatus(ctx, CleanupState.WaitingForGateFix({ attempts: attempt(5), failedGate: cmd }));

    const [, text] = setStatus.mock.calls[0] as [string, string];
    expect(text).toContain("5");
  });
});

// ---------------------------------------------------------------------------
// updateStatus — WaitingForFactoring
// ---------------------------------------------------------------------------

describe("updateStatus — WaitingForFactoring", () => {
  it("calls setStatus with a warning-colored factoring message", () => {
    const { ctx, setStatus, themeFg } = makeCtx();

    updateStatus(ctx, CleanupState.WaitingForFactoring({ attempts: attempt(1), priorHeadSHA: sha }));

    expect(themeFg).toHaveBeenCalledWith("warning", expect.stringContaining("factoring"));
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, expect.stringContaining("warning"));
  });

  it("includes the attempt count in the status text", () => {
    const { ctx, setStatus } = makeCtx();

    updateStatus(ctx, CleanupState.WaitingForFactoring({ attempts: attempt(4), priorHeadSHA: sha }));

    const [, text] = setStatus.mock.calls[0] as [string, string];
    expect(text).toContain("4");
  });
});

// ---------------------------------------------------------------------------
// updateStatus — AwaitingUserInput
// ---------------------------------------------------------------------------

describe("updateStatus — AwaitingUserInput", () => {
  it("calls setStatus with a muted stalled message", () => {
    const { ctx, setStatus, themeFg } = makeCtx();

    updateStatus(
      ctx,
      CleanupState.AwaitingUserInput({ reason: AwaitingReason.GatesUnconfigured() }),
    );

    expect(themeFg).toHaveBeenCalledWith("muted", expect.stringContaining("stalled"));
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, expect.stringContaining("muted"));
  });

  it("does not use warning color", () => {
    const { ctx, themeFg } = makeCtx();

    updateStatus(
      ctx,
      CleanupState.AwaitingUserInput({ reason: AwaitingReason.GatesUnconfigured() }),
    );

    expect(themeFg).not.toHaveBeenCalledWith("warning", expect.anything());
  });
});

// ---------------------------------------------------------------------------
// updateStatus — Disabled
// ---------------------------------------------------------------------------

describe("updateStatus — Disabled", () => {
  it("calls setStatus with a muted off message", () => {
    const { ctx, setStatus, themeFg } = makeCtx();

    updateStatus(ctx, CleanupState.Disabled());

    expect(themeFg).toHaveBeenCalledWith("muted", expect.stringContaining("off"));
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, expect.stringContaining("muted"));
  });

  it("does not use warning color", () => {
    const { ctx, themeFg } = makeCtx();

    updateStatus(ctx, CleanupState.Disabled());

    expect(themeFg).not.toHaveBeenCalledWith("warning", expect.anything());
  });
});

// ---------------------------------------------------------------------------
// STATUS_KEY constant
// ---------------------------------------------------------------------------

describe("STATUS_KEY", () => {
  it('equals "cleanup"', () => {
    expect(STATUS_KEY).toBe("cleanup");
  });
});

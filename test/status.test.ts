import { describe, expect, it, vi } from "vitest";
import { Either, Schema } from "effect";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { STATUS_KEY, updateStatus } from "../src/status.js";
import { CleanupState } from "../src/state-machine.js";
import { AttemptCount, AwaitingReason, decodeCommitSHA, decodeGateCommand } from "../src/types.js";

const attempt = (n: number): AttemptCount => Schema.decodeUnknownSync(AttemptCount)(n);
const sha = Either.getOrThrow(decodeCommitSHA("a".repeat(40)));
const cmd = Either.getOrThrow(decodeGateCommand("npm test"));

/**
 * Build a minimal mock ExtensionContext.
 * theme.fg returns `[role]text` so we can assert exact output.
 */
const makeCtx = () => {
  const setStatus = vi.fn();
  const themeFg = vi.fn((role: string, text: string) => `[${role}]${text}`);
  const ctx = { ui: { setStatus, theme: { fg: themeFg } } } as unknown as ExtensionContext;

  return { ctx, setStatus, themeFg };
};

describe("updateStatus", () => {
  it("Idle: clears status with undefined", () => {
    const { ctx, setStatus, themeFg } = makeCtx();
    updateStatus(ctx, CleanupState.Idle());

    expect(setStatus).toHaveBeenCalledWith("cleanup", undefined);
    expect(themeFg).not.toHaveBeenCalled();
  });

  it("WaitingForTreeFix: shows warning with attempt count", () => {
    const { ctx, setStatus, themeFg } = makeCtx();
    updateStatus(ctx, CleanupState.WaitingForTreeFix({ attempts: attempt(2) }));

    expect(themeFg).toHaveBeenCalledWith("warning", "🔧 dirty tree (attempt 2)");
    expect(setStatus).toHaveBeenCalledWith("cleanup", "[warning]🔧 dirty tree (attempt 2)");
  });

  it("WaitingForGateFix: shows warning with attempt count", () => {
    const { ctx, setStatus, themeFg } = makeCtx();
    updateStatus(ctx, CleanupState.WaitingForGateFix({ attempts: attempt(3), failedGate: cmd }));

    expect(themeFg).toHaveBeenCalledWith("warning", "🔧 gate failed (attempt 3)");
    expect(setStatus).toHaveBeenCalledWith("cleanup", "[warning]🔧 gate failed (attempt 3)");
  });

  it("WaitingForFactoring: shows warning with attempt count", () => {
    const { ctx, setStatus, themeFg } = makeCtx();
    updateStatus(ctx, CleanupState.WaitingForFactoring({ attempts: attempt(1), priorHeadSHA: sha }));

    expect(themeFg).toHaveBeenCalledWith("warning", "🔧 factoring (attempt 1)");
    expect(setStatus).toHaveBeenCalledWith("cleanup", "[warning]🔧 factoring (attempt 1)");
  });

  it("AwaitingUserInput: shows muted stalled message", () => {
    const { ctx, setStatus, themeFg } = makeCtx();
    updateStatus(ctx, CleanupState.AwaitingUserInput({ reason: AwaitingReason.GatesUnconfigured() }));

    expect(themeFg).toHaveBeenCalledWith("muted", "⏸ cleanup stalled");
    expect(setStatus).toHaveBeenCalledWith("cleanup", "[muted]⏸ cleanup stalled");
  });

  it("Disabled: shows muted off message", () => {
    const { ctx, setStatus, themeFg } = makeCtx();
    updateStatus(ctx, CleanupState.Disabled());

    expect(themeFg).toHaveBeenCalledWith("muted", "cleanup off");
    expect(setStatus).toHaveBeenCalledWith("cleanup", "[muted]cleanup off");
  });
});

describe("STATUS_KEY", () => {
  it('equals "cleanup"', () => {
    expect(STATUS_KEY).toBe("cleanup");
  });
});

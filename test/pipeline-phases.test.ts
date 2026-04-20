import { describe, expect, it, vi } from "vitest";
import { Either, Option, Schema } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  captureCollapseAnchor,
  collapseIfNeeded,
  formatCycleActions,
} from "../src/pipeline-collapse.js";
import {
  AtomicityPhaseOutcome,
  checkConvergence,
  DirtyTreePhaseOutcome,
  dispatch,
  runAtomicityPhase,
  runDirtyTreePhase,
  runGatePhase,
} from "../src/pipeline-phases.js";
import { createInitialRuntimeState } from "../src/runtime.js";
import { CleanupState } from "../src/state-machine.js";
import { AttemptCount, decodeCommitSHA, decodeGateCommand } from "../src/types.js";

// ---------------------------------------------------------------------------
// formatCycleActions
// ---------------------------------------------------------------------------

describe("formatCycleActions", () => {
  it("formats actions as bullet list", () => {
    const result = formatCycleActions(["Fixed gate", "Committed changes"]);
    expect(result).toStrictEqual("- Fixed gate\n- Committed changes");
  });

  it("returns default message for empty actions", () => {
    const result = formatCycleActions([]);
    expect(result).toStrictEqual(
      "- No fixes needed (all checks passed on first evaluation)",
    );
  });

  it("formats a single action", () => {
    const result = formatCycleActions(["Verified task completion"]);
    expect(result).toStrictEqual("- Verified task completion");
  });
});

// ---------------------------------------------------------------------------
// captureCollapseAnchor
// ---------------------------------------------------------------------------

const sha1 = Either.getOrThrow(decodeCommitSHA("a".repeat(40)));
const sha2 = Either.getOrThrow(decodeCommitSHA("b".repeat(40)));
const attempt = (n: number): typeof AttemptCount.Type => Schema.decodeUnknownSync(AttemptCount)(n);

const makeCtx = (leafId: string | null = "entry-123") => {
  const setStatus = vi.fn();
  const themeFg = vi.fn((role: string, text: string) => `[${role}]${text}`);
  const notify = vi.fn();
  const ctx = {
    sessionManager: { getLeafId: vi.fn(() => leafId) },
    ui: { notify, setStatus, theme: { fg: themeFg } },
  } as unknown as ExtensionContext;

  return { ctx, notify, setStatus };
};

const makePi = (overrides: Partial<Record<string, unknown>> = {}) => {
  const exec = vi.fn(async () => ({ code: 0, stderr: "", stdout: "" }));
  const appendEntry = vi.fn();
  const sendUserMessage = vi.fn();

  return {
    appendEntry,
    exec,
    pi: { appendEntry, exec, sendUserMessage, ...overrides } as unknown as ExtensionAPI,
    sendUserMessage,
  };
};

describe("captureCollapseAnchor", () => {
  it("captures leaf ID when no anchor exists", () => {
    const runtime = createInitialRuntimeState();
    const { ctx } = makeCtx("entry-abc");
    captureCollapseAnchor(runtime, ctx);

    expect(Option.isSome(runtime.collapseAnchorId)).toStrictEqual(true);
    const value = (runtime.collapseAnchorId as Option.Some<string>).value;
    expect(value).toStrictEqual("entry-abc");
  });

  it("does not overwrite existing anchor", () => {
    const runtime = createInitialRuntimeState();
    runtime.collapseAnchorId = Option.some("first-anchor");
    const { ctx } = makeCtx("entry-xyz");
    captureCollapseAnchor(runtime, ctx);

    const value = (runtime.collapseAnchorId as Option.Some<string>).value;
    expect(value).toStrictEqual("first-anchor");
  });

  it("does not set anchor when leaf ID is null", () => {
    const runtime = createInitialRuntimeState();
    const { ctx } = makeCtx(null);
    captureCollapseAnchor(runtime, ctx);

    expect(Option.isNone(runtime.collapseAnchorId)).toStrictEqual(true);
  });
});

// ---------------------------------------------------------------------------
// collapseIfNeeded
// ---------------------------------------------------------------------------

describe("collapseIfNeeded", () => {
  it("returns false when no anchor is set", async () => {
    const runtime = createInitialRuntimeState();
    runtime.commandCtx = Option.some({
      navigateTree: vi.fn(async () => ({ cancelled: false })),
    });
    const result = await collapseIfNeeded(runtime);
    expect(result).toStrictEqual(false);
  });

  it("returns false when no command context is set", async () => {
    const runtime = createInitialRuntimeState();
    runtime.collapseAnchorId = Option.some("anchor-123");
    const result = await collapseIfNeeded(runtime);
    expect(result).toStrictEqual(false);
  });

  it("calls navigateTree with anchor ID and summarize option", async () => {
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    const runtime = createInitialRuntimeState();
    runtime.collapseAnchorId = Option.some("anchor-456");
    runtime.commandCtx = Option.some({ navigateTree });
    runtime.cycleActions = ["Fixed gate"];

    const result = await collapseIfNeeded(runtime);

    expect(result).toStrictEqual(true);
    expect(navigateTree).toHaveBeenCalledWith("anchor-456", {
      customInstructions: "Cleanup cycle summary:\n- Fixed gate",
      summarize: true,
    });
  });

  it("clears anchor after collapse", async () => {
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    const runtime = createInitialRuntimeState();
    runtime.collapseAnchorId = Option.some("anchor-789");
    runtime.commandCtx = Option.some({ navigateTree });

    await collapseIfNeeded(runtime);

    expect(Option.isNone(runtime.collapseAnchorId)).toStrictEqual(true);
  });
});

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  it("transitions state and updates status", () => {
    const runtime = createInitialRuntimeState();
    const { ctx, setStatus } = makeCtx();

    dispatch(runtime, ctx, { _tag: "GitDirty", porcelain: "M foo.ts" } as any);

    expect(runtime.cleanup._tag).toStrictEqual("WaitingForTreeFix");
    expect(setStatus).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkConvergence
// ---------------------------------------------------------------------------

describe("checkConvergence", () => {
  it("returns false when not in WaitingForFactoring state", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    const { ctx } = makeCtx();

    const result = await checkConvergence(pi, runtime, ctx);
    expect(result).toStrictEqual(false);
  });

  it("returns false when HEAD is invalid", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForFactoring({
      attempts: attempt(1),
      priorHeadSHA: sha1,
    });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "invalid\n",
    });
    const { ctx } = makeCtx();

    const result = await checkConvergence(pi, runtime, ctx);
    expect(result).toStrictEqual(false);
  });

  it("returns false when HEAD differs from priorHeadSHA", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForFactoring({
      attempts: attempt(1),
      priorHeadSHA: sha1,
    });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: sha2 + "\n",
    });
    const { ctx } = makeCtx();

    const result = await checkConvergence(pi, runtime, ctx);
    expect(result).toStrictEqual(false);
  });

  it("returns true and persists SHA when HEAD matches priorHeadSHA", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForFactoring({
      attempts: attempt(1),
      priorHeadSHA: sha1,
    });
    const { appendEntry, pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: sha1 + "\n",
    });
    const { ctx } = makeCtx();

    const result = await checkConvergence(pi, runtime, ctx);
    expect(result).toStrictEqual(true);
    expect(appendEntry).toHaveBeenCalled();
    expect(Option.isSome(runtime.lastCleanCommitSHA)).toStrictEqual(true);
  });
});

// ---------------------------------------------------------------------------
// runGatePhase
// ---------------------------------------------------------------------------

describe("runGatePhase", () => {
  it("returns None and transitions when no gate config", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    const { ctx, notify } = makeCtx();

    const result = await runGatePhase(pi, runtime, ctx);
    expect(Option.isNone(result)).toStrictEqual(true);
    expect(runtime.cleanup._tag).toStrictEqual("AwaitingUserInput");
    expect(notify).toHaveBeenCalledWith(
      "No quality gates configured. Use /gates to set up.",
      "warning",
    );
  });

  it("returns Some(gateConfig) when all gates pass", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    const config = { commands: [cmd] as const, description: "test" };
    runtime.gateConfig = Option.some(config);
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "ok",
    });
    const { ctx } = makeCtx();

    const result = await runGatePhase(pi, runtime, ctx);
    expect(Option.isSome(result)).toStrictEqual(true);
    if (Option.isSome(result)) {
      expect(result.value).toStrictEqual(config);
    }
  });

  it("returns None and sends fix message when gate fails", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 1,
      stderr: "error",
      stdout: "FAIL",
    });
    const { ctx } = makeCtx();

    const result = await runGatePhase(pi, runtime, ctx);
    expect(Option.isNone(result)).toStrictEqual(true);
    expect(runtime.cleanup._tag).toStrictEqual("WaitingForGateFix");
    expect(sendUserMessage).toHaveBeenCalled();
  });

  it("does not record a cycle action when sending the initial fix request", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 1,
      stderr: "error",
      stdout: "FAIL",
    });
    const { ctx } = makeCtx();

    await runGatePhase(pi, runtime, ctx);

    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("transitions out of WaitingForGateFix when gates now pass", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.cleanup = CleanupState.WaitingForGateFix({
      attempts: attempt(1),
      failedGate: cmd,
    });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "ok",
    });
    const { ctx } = makeCtx();

    await runGatePhase(pi, runtime, ctx);

    expect(runtime.cleanup._tag).toStrictEqual("Idle");
  });

  it("preserves WaitingForTreeFix attempts when gates pass during a tree-fix cycle", async () => {
    // Regression: dispatching GatesPassed unconditionally from any state
    // would reset WaitingForTreeFix(attempts=4) → Idle → (tree still dirty)
    // → WaitingForTreeFix(attempts=1), defeating max-attempt stalling.
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.cleanup = CleanupState.WaitingForTreeFix({ attempts: attempt(4) });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "ok",
    });
    const { ctx } = makeCtx();

    await runGatePhase(pi, runtime, ctx);

    expect(runtime.cleanup._tag).toStrictEqual("WaitingForTreeFix");
    if (runtime.cleanup._tag === "WaitingForTreeFix") {
      expect(Number(runtime.cleanup.attempts)).toStrictEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// runDirtyTreePhase
// ---------------------------------------------------------------------------

describe("runDirtyTreePhase", () => {
  it("returns Clean when tree is clean", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "",
    });
    const { ctx } = makeCtx();

    const result = await runDirtyTreePhase(pi, runtime, ctx);
    expect(result).toStrictEqual(DirtyTreePhaseOutcome.Clean());
  });

  it("returns CommitRequested and sends commit message when dirty", async () => {
    const runtime = createInitialRuntimeState();
    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "M foo.ts\n",
    });
    const { ctx } = makeCtx();

    const result = await runDirtyTreePhase(pi, runtime, ctx);
    expect(result).toStrictEqual(
      DirtyTreePhaseOutcome.CommitRequested({ porcelain: "M foo.ts" }),
    );
    expect(runtime.cleanup._tag).toStrictEqual("WaitingForTreeFix");
    expect(sendUserMessage).toHaveBeenCalled();
  });

  it("returns NotARepo when not a git repo", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 128,
      stderr: "fatal: not a git repository",
      stdout: "",
    });
    const { ctx } = makeCtx();

    const result = await runDirtyTreePhase(pi, runtime, ctx);
    expect(result).toStrictEqual(DirtyTreePhaseOutcome.NotARepo());
  });

  it("does not record a cycle action when sending the initial commit request", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "M foo.ts\n",
    });
    const { ctx } = makeCtx();

    await runDirtyTreePhase(pi, runtime, ctx);

    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("transitions out of WaitingForTreeFix when tree is now clean", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForTreeFix({ attempts: attempt(1) });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "",
    });
    const { ctx } = makeCtx();

    await runDirtyTreePhase(pi, runtime, ctx);

    expect(runtime.cleanup._tag).toStrictEqual("Idle");
  });

  it("preserves WaitingForGateFix attempts when tree is clean during a gate-fix cycle", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.cleanup = CleanupState.WaitingForGateFix({
      attempts: attempt(3),
      failedGate: cmd,
    });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "",
    });
    const { ctx } = makeCtx();

    await runDirtyTreePhase(pi, runtime, ctx);

    expect(runtime.cleanup._tag).toStrictEqual("WaitingForGateFix");
    if (runtime.cleanup._tag === "WaitingForGateFix") {
      expect(Number(runtime.cleanup.attempts)).toStrictEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// runAtomicityPhase
// ---------------------------------------------------------------------------

describe("runAtomicityPhase — cycleActions timing", () => {
  const gateCmd = Either.getOrThrow(decodeGateCommand("npm test"));
  const gateConfig = { commands: [gateCmd] as const, description: "test" };

  const primeAtomicityExec = (pi: ExtensionAPI, commitCount: string): void => {
    (pi.exec as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: String(sha1) + "\n" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: commitCount });
  };

  it("returns FactoringRequested and does not record a cycle action on the initial factor request", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    primeAtomicityExec(pi, "5");
    const { ctx } = makeCtx();

    const result = await runAtomicityPhase({
      baseSHA: Option.some(sha2),
      ctx,
      gateConfig,
      pi,
      runtime,
    });

    expect(result).toStrictEqual(
      AtomicityPhaseOutcome.FactoringRequested({
        baseSHA: sha2,
        commitCount: 5,
        headSHA: sha1,
      }),
    );
    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("returns Atomic and does not record a cycle action when first-cycle commits are already atomic", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    primeAtomicityExec(pi, "1");
    const { ctx } = makeCtx();

    const result = await runAtomicityPhase({
      baseSHA: Option.some(sha2),
      ctx,
      gateConfig,
      pi,
      runtime,
    });

    expect(result).toStrictEqual(AtomicityPhaseOutcome.Atomic({ headSHA: sha1 }));
    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("returns NoBase when the comparable base equals HEAD", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: String(sha1) + "\n",
    });
    const { ctx } = makeCtx();

    const result = await runAtomicityPhase({
      baseSHA: Option.some(sha1),
      ctx,
      gateConfig,
      pi,
      runtime,
    });

    expect(result).toStrictEqual(AtomicityPhaseOutcome.NoBase({ headSHA: sha1 }));
    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("returns Indeterminate when atomicity cannot parse HEAD", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "invalid\n",
    });
    const { ctx } = makeCtx();

    const result = await runAtomicityPhase({
      baseSHA: Option.some(sha2),
      ctx,
      gateConfig,
      pi,
      runtime,
    });

    expect(result).toStrictEqual(AtomicityPhaseOutcome.Indeterminate());
    expect(runtime.cleanup._tag).toStrictEqual("Idle");
  });
});



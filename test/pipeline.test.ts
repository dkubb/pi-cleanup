import { describe, expect, it, vi } from "vitest";
import { Either, Option } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { isGitUnchanged, resolveBaseSHA } from "../src/phases/git-status.js";
import { handleAgentEnd, recordPriorCycleCompletion } from "../src/pipeline.js";
import { isCycleInProgress } from "../src/pipeline-skip.js";
import { getCommitCount, runReviewIfNeeded } from "../src/pipeline-review.js";
import { createInitialRuntimeState } from "../src/runtime.js";
import { CleanupState } from "../src/state-machine.js";
import { AttemptCount, decodeCommitSHA, decodeGateCommand } from "../src/types.js";
import { Schema } from "effect";

const sha1 = Either.getOrThrow(decodeCommitSHA("a".repeat(40)));
const sha2 = Either.getOrThrow(decodeCommitSHA("b".repeat(40)));

const makeCtx = (leafId: string | null = "entry-123") => {
  const ctx = {
    sessionManager: { getLeafId: vi.fn(() => leafId) },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: vi.fn((role: string, text: string) => `[${role}]${text}`) },
    },
  } as unknown as ExtensionContext;

  return { ctx };
};

const makePi = () => {
  const sendUserMessage = vi.fn();

  return {
    pi: {
      appendEntry: vi.fn(),
      exec: vi.fn(async () => ({ code: 0, stderr: "", stdout: "" })),
      sendUserMessage,
    } as unknown as ExtensionAPI,
    sendUserMessage,
  };
};

const makeReviewInput = (overrides: Record<string, unknown> = {}) => {
  const runtime = createInitialRuntimeState();
  const { pi, sendUserMessage } = makePi();
  const { ctx } = makeCtx();

  return {
    input: {
      baseSHA: Option.some(sha2),
      commitCount: Option.some(3),
      headEither: Either.right(sha1),
      phaseCtx: { ctx, pi, runtime },
      ...overrides,
    },
    runtime,
    sendUserMessage,
  };
};

// ---------------------------------------------------------------------------
// isCycleInProgress
// ---------------------------------------------------------------------------

describe("isCycleInProgress", () => {
  it("returns false when nothing is pending", () => {
    const runtime = createInitialRuntimeState();
    expect(isCycleInProgress(runtime)).toStrictEqual(false);
  });

  it("returns true when reviewPending is true", () => {
    const runtime = createInitialRuntimeState();
    runtime.reviewPending = true;
    expect(isCycleInProgress(runtime)).toStrictEqual(true);
  });

  it("returns true when evalPending is true", () => {
    const runtime = createInitialRuntimeState();
    runtime.evalPending = true;
    expect(isCycleInProgress(runtime)).toStrictEqual(true);
  });
});

// ---------------------------------------------------------------------------
// runReviewIfNeeded
// ---------------------------------------------------------------------------

describe("runReviewIfNeeded", () => {
  it("returns false when review is already complete", () => {
    const { input, runtime, sendUserMessage } = makeReviewInput();
    runtime.reviewComplete = true;

    expect(runReviewIfNeeded(input)).toStrictEqual(false);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns false when HEAD is invalid", () => {
    const { input } = makeReviewInput({ headEither: Either.left("invalid") });

    expect(runReviewIfNeeded(input)).toStrictEqual(false);
  });

  it("returns false when base equals head", () => {
    const { input, sendUserMessage } = makeReviewInput({
      baseSHA: Option.some(sha1),
      headEither: Either.right(sha1),
    });

    expect(runReviewIfNeeded(input)).toStrictEqual(false);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns false when baseSHA is None", () => {
    const { input } = makeReviewInput({ baseSHA: Option.none() });

    expect(runReviewIfNeeded(input)).toStrictEqual(false);
  });

  it("sends review message and returns true on first call", () => {
    const { input, runtime, sendUserMessage } = makeReviewInput();

    expect(runReviewIfNeeded(input)).toStrictEqual(true);
    expect(runtime.reviewPending).toStrictEqual(true);
    expect(sendUserMessage).toHaveBeenCalled();
  });

  it("marks review complete and returns false on second call", () => {
    const { input, runtime } = makeReviewInput();
    runtime.reviewPending = true;

    expect(runReviewIfNeeded(input)).toStrictEqual(false);
    expect(runtime.reviewComplete).toStrictEqual(true);
    expect(runtime.reviewPending).toStrictEqual(false);
  });

  it("captures collapse anchor on first call", () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    const { ctx } = makeCtx("leaf-456");

    runReviewIfNeeded({
      baseSHA: Option.some(sha2),
      commitCount: Option.some(1),
      headEither: Either.right(sha1),
      phaseCtx: { ctx, pi, runtime },
    });
    expect(Option.isSome(runtime.collapseAnchorId)).toStrictEqual(true);
  });

  it("does not record a cycle action on the initial review request", () => {
    const { input, runtime } = makeReviewInput();

    runReviewIfNeeded(input);
    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("records a cycle action when the second pass marks review complete", () => {
    const { input, runtime } = makeReviewInput();
    runtime.reviewPending = true;

    runReviewIfNeeded(input);
    expect(runtime.cycleActions).toStrictEqual(["Delegated code review to subagent"]);
  });
});

// ---------------------------------------------------------------------------
// recordPriorCycleCompletion
// ---------------------------------------------------------------------------

const attempt = (n: number): typeof AttemptCount.Type => Schema.decodeUnknownSync(AttemptCount)(n);

describe("recordPriorCycleCompletion", () => {
  it("records nothing when entry state is Idle", async () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("records 'Committed uncommitted changes' when WaitingForTreeFix and tree is now clean", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForTreeFix({ attempts: attempt(1) });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stderr: "", stdout: "" });

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual(["Committed uncommitted changes"]);
  });

  it("records nothing when WaitingForTreeFix but tree is still dirty", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForTreeFix({ attempts: attempt(1) });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "M foo.ts\n",
    });

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("records 'Fixed failing gate' when WaitingForGateFix and gates now pass", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.cleanup = CleanupState.WaitingForGateFix({ attempts: attempt(1), failedGate: cmd });
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stderr: "", stdout: "ok" });

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual(["Fixed failing gate: `npm test`"]);
  });

  it("records nothing when WaitingForGateFix but gates still fail", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.cleanup = CleanupState.WaitingForGateFix({ attempts: attempt(1), failedGate: cmd });
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 1,
      stderr: "err",
      stdout: "FAIL",
    });

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("records nothing when WaitingForGateFix but gateConfig is None", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.cleanup = CleanupState.WaitingForGateFix({ attempts: attempt(1), failedGate: cmd });
    const { pi } = makePi();

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("records nothing when the failing gate was reconfigured out of the gate list", async () => {
    const runtime = createInitialRuntimeState();
    const oldCmd = Either.getOrThrow(decodeGateCommand("npm test"));
    const newCmd = Either.getOrThrow(decodeGateCommand("npm run lint"));
    runtime.cleanup = CleanupState.WaitingForGateFix({
      attempts: attempt(1),
      failedGate: oldCmd,
    });
    runtime.gateConfig = Option.some({ commands: [newCmd], description: "new" });
    const { pi } = makePi();

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual([]);
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("records 'Factored commits' when WaitingForFactoring, HEAD moved, and range is now atomic", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForFactoring({
      attempts: attempt(1),
      priorHeadSHA: sha2,
    });
    runtime.lastCleanCommitSHA = Option.some(sha2);
    const { pi } = makePi();
    // HEAD query (for our predicate), then checkAtomicity's HEAD query,
    // then its rev-list --count which returns "1" (atomic).
    (pi.exec as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: String(sha1) + "\n" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: String(sha1) + "\n" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: "1\n" });

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual(["Factored commits into atomic units"]);
  });

  it("records nothing when WaitingForFactoring, HEAD moved, but range still needs more factoring", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForFactoring({
      attempts: attempt(1),
      priorHeadSHA: sha2,
    });
    runtime.lastCleanCommitSHA = Option.some(sha2);
    const { pi } = makePi();
    // HEAD query, then checkAtomicity HEAD, then rev-list --count "3" (still non-atomic).
    (pi.exec as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: String(sha1) + "\n" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: String(sha1) + "\n" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: "3\n" });

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual([]);
  });

  it("records nothing when WaitingForFactoring but HEAD is unchanged (convergence)", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForFactoring({
      attempts: attempt(1),
      priorHeadSHA: sha1,
    });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: String(sha1) + "\n",
    });

    await recordPriorCycleCompletion(pi, runtime);

    expect(runtime.cycleActions).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handleAgentEnd — max-attempts + prior-completion ordering
// ---------------------------------------------------------------------------

describe("handleAgentEnd", () => {
  it("does not stall on max attempts when the agent just succeeded", async () => {
    // If the 5th allowed attempt actually fixed the issue,
    // recordPriorCycleCompletion observes success and adds a cycleAction.
    // The handler must not then stall to AwaitingUserInput based on the
    // stale attempt counter — it should let the phase pipeline transition
    // state back to Idle.
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.cleanup = CleanupState.WaitingForGateFix({ attempts: attempt(5), failedGate: cmd });
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "ok",
    });
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect(runtime.cycleActions).toStrictEqual(["Fixed failing gate: `npm test`"]);
    expect(runtime.cleanup._tag).not.toStrictEqual("AwaitingUserInput");
  });

  it("stalls on max attempts when the agent is still stuck (no progress observed)", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.cleanup = CleanupState.WaitingForGateFix({ attempts: attempt(5), failedGate: cmd });
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 1,
      stderr: "err",
      stdout: "FAIL",
    });
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect(runtime.cycleActions).toStrictEqual([]);
    expect(runtime.cleanup._tag).toStrictEqual("AwaitingUserInput");
  });

  it("bails out without recording when state is not actionable", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.Disabled();
    const { pi } = makePi();
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect(runtime.cycleActions).toStrictEqual([]);
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("does not short-circuit in WaitingForGateFix when git state is unchanged (flaky gate now passing)", async () => {
    // Regression: isGitUnchanged would see HEAD==lastClean + clean tree and
    // bail, leaving the cycle stuck in WaitingForGateFix even though the
    // gate now passes on this run.
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    runtime.cleanup = CleanupState.WaitingForGateFix({ attempts: attempt(1), failedGate: cmd });
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.lastCleanCommitSHA = Option.some(sha1);
    const { pi } = makePi();
    // recordGateFixIfPassing only: runs gates once (HEAD probe skipped since
    // we now gate the short-circuit on Idle).
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "ok",
    });
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect(runtime.cycleActions).toStrictEqual(["Fixed failing gate: `npm test`"]);
  });
});

// ---------------------------------------------------------------------------
// isGitUnchanged
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getCommitCount
// ---------------------------------------------------------------------------

describe("getCommitCount", () => {
  it("returns None when HEAD is invalid", async () => {
    const { pi } = makePi();
    const result = await getCommitCount(pi, Either.left("bad"), Option.some(sha1));
    expect(result).toStrictEqual(Option.none());
  });

  it("returns None when baseSHA is None", async () => {
    const { pi } = makePi();
    const result = await getCommitCount(pi, Either.right(sha1), Option.none());
    expect(result).toStrictEqual(Option.none());
  });

  it("returns Some(count) from rev-list output", async () => {
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "5\n",
    });
    const result = await getCommitCount(pi, Either.right(sha1), Option.some(sha2));
    expect(result).toStrictEqual(Option.some(5));
  });

  it("returns None when rev-list output is not a number (no longer coerces to 0)", async () => {
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "not-a-number\n",
    });
    const result = await getCommitCount(pi, Either.right(sha1), Option.some(sha2));
    expect(result).toStrictEqual(Option.none());
  });
});

// ---------------------------------------------------------------------------
// isGitUnchanged
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveBaseSHA
// ---------------------------------------------------------------------------

describe("resolveBaseSHA", () => {
  it("returns lastCleanSHA when present", async () => {
    const exec = vi.fn();
    const result = await resolveBaseSHA(exec, Option.some(sha1));

    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof sha1>).value;
    expect(value).toStrictEqual(sha1);
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to merge-base when no lastCleanSHA", async () => {
    const exec = vi.fn(async () => ({ code: 0, stderr: "", stdout: sha2 + "\n" }));
    const result = await resolveBaseSHA(exec, Option.none());

    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof sha2>).value;
    expect(value).toStrictEqual(sha2);
  });

  it("returns None when no lastCleanSHA and no default branch", async () => {
    const exec = vi.fn(async () => ({ code: 1, stderr: "", stdout: "" }));
    const result = await resolveBaseSHA(exec, Option.none());

    expect(Option.isNone(result)).toStrictEqual(true);
  });
});

// ---------------------------------------------------------------------------
// isGitUnchanged
// ---------------------------------------------------------------------------

describe("isGitUnchanged", () => {
  it("returns false when no lastCleanCommitSHA", async () => {
    const exec = vi.fn(async () => ({ code: 0, stderr: "", stdout: "" }));

    expect(await isGitUnchanged(exec, Option.none())).toStrictEqual(false);
  });

  it("returns false when HEAD differs from lastCleanCommitSHA", async () => {
    const exec = vi.fn(async () => ({ code: 0, stderr: "", stdout: sha2 + "\n" }));

    expect(await isGitUnchanged(exec, Option.some(sha1))).toStrictEqual(false);
  });

  it("returns false when HEAD is invalid", async () => {
    const exec = vi.fn(async () => ({ code: 1, stderr: "error", stdout: "invalid\n" }));

    expect(await isGitUnchanged(exec, Option.some(sha1))).toStrictEqual(false);
  });

  it("returns false when HEAD matches but tree is dirty", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: sha1 + "\n" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: "M foo.ts\n" });

    expect(await isGitUnchanged(exec, Option.some(sha1))).toStrictEqual(false);
  });

  it("returns true when HEAD matches and tree is clean", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: sha1 + "\n" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: "" });

    expect(await isGitUnchanged(exec, Option.some(sha1))).toStrictEqual(true);
  });

  it("returns false when HEAD matches but git status exits non-zero", async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: sha1 + "\n" })
      .mockResolvedValueOnce({ code: 128, stderr: "fatal: not a repo", stdout: "" });

    expect(await isGitUnchanged(exec, Option.some(sha1))).toStrictEqual(false);
  });
});

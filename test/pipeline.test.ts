import { describe, expect, it, vi } from "vitest";
import { Either, Option } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { isGitUnchanged, resolveBaseSHA } from "../src/phases/git-status.js";
import { getAttempts, handleAgentEnd, recordPriorCycleCompletion } from "../src/pipeline.js";
import { isCycleInProgress } from "../src/pipeline-skip.js";
import {
  getCommitCount,
  ReviewPhaseOutcome,
  ReviewSkipReason,
  runReviewIfNeeded,
} from "../src/pipeline-review.js";
import { createInitialRuntimeState } from "../src/runtime.js";
import { CleanupState } from "../src/state-machine.js";
import { AttemptCount, AwaitingReason, decodeCommitSHA, decodeGateCommand } from "../src/types.js";
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

const installPassingReviewExec = (pi: ExtensionAPI) => {
  (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
    async (bin: string, args: ReadonlyArray<string>) => {
      const argStr = args.join(" ");

      if (bin === "bash") {
        return { code: 0, stderr: "", stdout: "ok" };
      }

      if (bin === "git" && argStr === "rev-parse --git-dir") {
        return { code: 0, stderr: "", stdout: ".git\n" };
      }

      if (bin === "git" && argStr === "status --porcelain=v1") {
        return { code: 0, stderr: "", stdout: "" };
      }

      if (bin === "git" && argStr === "rev-parse HEAD") {
        return { code: 0, stderr: "", stdout: String(sha1) + "\n" };
      }

      if (bin === "git" && argStr === `rev-list --count ${String(sha2)}..${String(sha1)}`) {
        return { code: 0, stderr: "", stdout: "2\n" };
      }

      // Commands reached by the atomicity phase after review completion.
      if (bin === "git" && argStr === `rev-list --count ${String(sha2)}..HEAD`) {
        return { code: 0, stderr: "", stdout: "1\n" };
      }

      if (bin === "git" && argStr.startsWith("rev-list --reverse ")) {
        return { code: 0, stderr: "", stdout: `${String(sha1)}\n` };
      }

      throw new Error(`unexpected exec: ${bin} ${argStr}`);
    },
  );
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
  it("returns Skipped(AlreadyComplete) when review is already complete", () => {
    const { input, runtime, sendUserMessage } = makeReviewInput();
    runtime.reviewComplete = true;

    expect(runReviewIfNeeded(input)).toStrictEqual(
      ReviewPhaseOutcome.Skipped({ reason: ReviewSkipReason.AlreadyComplete() }),
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns Skipped(HeadUnavailable) when HEAD is invalid", () => {
    const { input } = makeReviewInput({ headEither: Either.left("invalid") });

    expect(runReviewIfNeeded(input)).toStrictEqual(
      ReviewPhaseOutcome.Skipped({ reason: ReviewSkipReason.HeadUnavailable() }),
    );
  });

  it("returns Skipped(EmptyRange) when base equals head", () => {
    const { input, sendUserMessage } = makeReviewInput({
      baseSHA: Option.some(sha1),
      headEither: Either.right(sha1),
    });

    expect(runReviewIfNeeded(input)).toStrictEqual(
      ReviewPhaseOutcome.Skipped({ reason: ReviewSkipReason.EmptyRange() }),
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns Skipped(BaseUnavailable) when baseSHA is None", () => {
    const { input } = makeReviewInput({ baseSHA: Option.none() });

    expect(runReviewIfNeeded(input)).toStrictEqual(
      ReviewPhaseOutcome.Skipped({ reason: ReviewSkipReason.BaseUnavailable() }),
    );
  });

  it("returns Skipped(CommitCountUnavailable) when commitCount is None", () => {
    const { input } = makeReviewInput({ commitCount: Option.none() });

    expect(runReviewIfNeeded(input)).toStrictEqual(
      ReviewPhaseOutcome.Skipped({ reason: ReviewSkipReason.CommitCountUnavailable() }),
    );
  });

  it("sends review message and returns Requested on first call", () => {
    const { input, runtime, sendUserMessage } = makeReviewInput();

    expect(runReviewIfNeeded(input)).toStrictEqual(ReviewPhaseOutcome.Requested());
    expect(runtime.reviewPending).toStrictEqual(true);
    expect(sendUserMessage).toHaveBeenCalled();
  });

  it("marks review complete and returns Completed on second call", () => {
    const { input, runtime } = makeReviewInput();
    runtime.reviewPending = true;

    expect(runReviewIfNeeded(input)).toStrictEqual(ReviewPhaseOutcome.Completed());
    expect(runtime.reviewComplete).toStrictEqual(true);
    expect(runtime.reviewPending).toStrictEqual(false);
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

  it("short-circuits when idle git state is unchanged", async () => {
    const runtime = createInitialRuntimeState();
    runtime.lastCleanCommitSHA = Option.some(sha1);
    runtime.mutationDetected = true;
    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_bin: string, args: ReadonlyArray<string>) => {
        const argStr = args.join(" ");
        if (argStr === "rev-parse HEAD") {
          return { code: 0, stderr: "", stdout: String(sha1) + "\n" };
        }
        if (argStr === "status --porcelain") {
          return { code: 0, stderr: "", stdout: "" };
        }
        return { code: 0, stderr: "", stdout: "" };
      },
    );
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      mutationDetected: runtime.mutationDetected,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      mutationDetected: false,
      sendUserMessageCalls: 0,
    });
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

  it("continues to eval when the initial repo probe says git is unavailable", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });

    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (bin: string, args: ReadonlyArray<string>) => {
        const argStr = args.join(" ");

        if (bin === "bash") {
          return { code: 0, stderr: "", stdout: "ok" };
        }

        if (bin === "git" && argStr === "rev-parse --git-dir") {
          return { code: 128, stderr: "fatal: not a git repository", stdout: "" };
        }

        throw new Error(`unexpected exec: ${bin} ${argStr}`);
      },
    );
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      cleanupState: runtime.cleanup._tag,
      evalPending: runtime.evalPending,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      cleanupState: "Idle",
      evalPending: true,
      sendUserMessageCalls: 1,
    });
  });

  it("returns before eval when git status becomes NotARepo after a successful repo probe", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });

    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (bin: string, args: ReadonlyArray<string>) => {
        const argStr = args.join(" ");

        if (bin === "bash") {
          return { code: 0, stderr: "", stdout: "ok" };
        }

        if (bin === "git" && argStr === "rev-parse --git-dir") {
          return { code: 0, stderr: "", stdout: ".git\n" };
        }

        if (bin === "git" && argStr === "status --porcelain=v1") {
          return { code: 128, stderr: "fatal: not a git repository", stdout: "" };
        }

        throw new Error(`unexpected exec: ${bin} ${argStr}`);
      },
    );
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      cleanupState: runtime.cleanup._tag,
      evalPending: runtime.evalPending,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      cleanupState: "Idle",
      evalPending: false,
      sendUserMessageCalls: 0,
    });
  });

  it("returns after requesting review and does not continue to eval", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.lastCleanCommitSHA = Option.some(sha2);
    runtime.mutationDetected = true;

    const { pi, sendUserMessage } = makePi();
    installPassingReviewExec(pi);
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      appendEntryCalls: (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.length,
      evalPending: runtime.evalPending,
      reviewComplete: runtime.reviewComplete,
      reviewPending: runtime.reviewPending,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      appendEntryCalls: 0,
      evalPending: false,
      reviewComplete: false,
      reviewPending: true,
      sendUserMessageCalls: 1,
    });
  });

  it("continues past completed review into the atomicity and eval phases", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.lastCleanCommitSHA = Option.some(sha2);
    runtime.reviewPending = true;

    const { pi, sendUserMessage } = makePi();
    installPassingReviewExec(pi);
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      cycleActions: runtime.cycleActions,
      evalPending: runtime.evalPending,
      reviewComplete: runtime.reviewComplete,
      reviewPending: runtime.reviewPending,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      cycleActions: ["Delegated code review to subagent"],
      evalPending: true,
      reviewComplete: true,
      reviewPending: false,
      sendUserMessageCalls: 1,
    });
  });

  it("returns after requesting factoring and does not continue to eval", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.lastCleanCommitSHA = Option.some(sha2);
    runtime.mutationDetected = true;
    runtime.reviewComplete = true;

    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (bin: string, args: ReadonlyArray<string>) => {
        const argStr = args.join(" ");

        if (bin === "bash") {
          return { code: 0, stderr: "", stdout: "ok" };
        }

        if (bin === "git" && argStr === "rev-parse --git-dir") {
          return { code: 0, stderr: "", stdout: ".git\n" };
        }

        if (bin === "git" && argStr === "status --porcelain=v1") {
          return { code: 0, stderr: "", stdout: "" };
        }

        if (bin === "git" && argStr === "rev-parse HEAD") {
          return { code: 0, stderr: "", stdout: String(sha1) + "\n" };
        }

        if (bin === "git" && argStr === `rev-list --count ${String(sha2)}..${String(sha1)}`) {
          return { code: 0, stderr: "", stdout: "3\n" };
        }

        if (bin === "git" && argStr === `rev-list --count ${String(sha2)}..HEAD`) {
          return { code: 0, stderr: "", stdout: "3\n" };
        }

        throw new Error(`unexpected exec: ${bin} ${argStr}`);
      },
    );
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      appendEntryCalls: (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.length,
      cleanupState: runtime.cleanup._tag,
      evalPending: runtime.evalPending,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      appendEntryCalls: 0,
      cleanupState: "WaitingForFactoring",
      evalPending: false,
      sendUserMessageCalls: 1,
    });
  });

  it("sends the eval message when atomicity confirms commits are atomic", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.lastCleanCommitSHA = Option.some(sha2);
    runtime.mutationDetected = true;
    runtime.reviewComplete = true;

    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (bin: string, args: ReadonlyArray<string>) => {
        const argStr = args.join(" ");

        if (bin === "bash") {
          return { code: 0, stderr: "", stdout: "ok" };
        }

        if (bin === "git" && argStr === "rev-parse --git-dir") {
          return { code: 0, stderr: "", stdout: ".git\n" };
        }

        if (bin === "git" && argStr === "status --porcelain=v1") {
          return { code: 0, stderr: "", stdout: "" };
        }

        if (bin === "git" && argStr === "rev-parse HEAD") {
          return { code: 0, stderr: "", stdout: String(sha1) + "\n" };
        }

        if (bin === "git" && argStr === `rev-list --count ${String(sha2)}..${String(sha1)}`) {
          return { code: 0, stderr: "", stdout: "1\n" };
        }

        if (bin === "git" && argStr === `rev-list --count ${String(sha2)}..HEAD`) {
          return { code: 0, stderr: "", stdout: "1\n" };
        }

        throw new Error(`unexpected exec: ${bin} ${argStr}`);
      },
    );
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      appendEntryCalls: (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.length,
      cleanupState: runtime.cleanup._tag,
      evalPending: runtime.evalPending,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      appendEntryCalls: 1,
      cleanupState: "Idle",
      evalPending: true,
      sendUserMessageCalls: 1,
    });
  });

  it("sends the eval message when atomicity has no comparable base", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.lastCleanCommitSHA = Option.some(sha1);
    runtime.mutationDetected = true;
    runtime.reviewComplete = true;

    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (bin: string, args: ReadonlyArray<string>) => {
        const argStr = args.join(" ");

        if (bin === "bash") {
          return { code: 0, stderr: "", stdout: "ok" };
        }

        if (bin === "git" && argStr === "rev-parse --git-dir") {
          return { code: 0, stderr: "", stdout: ".git\n" };
        }

        if (bin === "git" && argStr === "status --porcelain") {
          return { code: 0, stderr: "", stdout: "M foo.ts\n" };
        }

        if (bin === "git" && argStr === "status --porcelain=v1") {
          return { code: 0, stderr: "", stdout: "" };
        }

        if (bin === "git" && argStr === "rev-parse HEAD") {
          return { code: 0, stderr: "", stdout: String(sha1) + "\n" };
        }

        if (bin === "git" && argStr === `rev-list --count ${String(sha1)}..${String(sha1)}`) {
          return { code: 0, stderr: "", stdout: "0\n" };
        }

        throw new Error(`unexpected exec: ${bin} ${argStr}`);
      },
    );
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      appendEntryCalls: (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.length,
      cleanupState: runtime.cleanup._tag,
      evalPending: runtime.evalPending,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      appendEntryCalls: 1,
      cleanupState: "Idle",
      evalPending: true,
      sendUserMessageCalls: 1,
    });
  });

  it("sends the eval message when atomicity is indeterminate", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.lastCleanCommitSHA = Option.some(sha2);
    runtime.mutationDetected = true;
    runtime.reviewComplete = true;

    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (bin: string, args: ReadonlyArray<string>) => {
        const argStr = args.join(" ");

        if (bin === "bash") {
          return { code: 0, stderr: "", stdout: "ok" };
        }

        if (bin === "git" && argStr === "rev-parse --git-dir") {
          return { code: 0, stderr: "", stdout: ".git\n" };
        }

        if (bin === "git" && argStr === "status --porcelain=v1") {
          return { code: 0, stderr: "", stdout: "" };
        }

        if (bin === "git" && argStr === "rev-parse HEAD") {
          return { code: 0, stderr: "", stdout: "invalid\n" };
        }

        throw new Error(`unexpected exec: ${bin} ${argStr}`);
      },
    );
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      appendEntryCalls: (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.length,
      cleanupState: runtime.cleanup._tag,
      evalPending: runtime.evalPending,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      appendEntryCalls: 0,
      cleanupState: "Idle",
      evalPending: true,
      sendUserMessageCalls: 1,
    });
  });

  it("completes the cycle on the second eval pass after all phases pass", async () => {
    const runtime = createInitialRuntimeState();
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.lastCleanCommitSHA = Option.some(sha2);
    runtime.reviewComplete = true;
    runtime.evalPending = true;
    runtime.commandCtx = Option.some({
      navigateTree: vi.fn(async () => ({ cancelled: false })),
    });
    runtime.collapseAnchorId = Option.some("entry-123");

    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (bin: string, args: ReadonlyArray<string>) => {
        const argStr = args.join(" ");

        if (bin === "bash") {
          return { code: 0, stderr: "", stdout: "ok" };
        }

        if (bin === "git" && argStr === "rev-parse --git-dir") {
          return { code: 0, stderr: "", stdout: ".git\n" };
        }

        if (bin === "git" && argStr === "status --porcelain=v1") {
          return { code: 0, stderr: "", stdout: "" };
        }

        if (bin === "git" && argStr === "rev-parse HEAD") {
          return { code: 0, stderr: "", stdout: String(sha1) + "\n" };
        }

        if (bin === "git" && argStr === `rev-list --count ${String(sha2)}..${String(sha1)}`) {
          return { code: 0, stderr: "", stdout: "1\n" };
        }

        if (bin === "git" && argStr === `rev-list --count ${String(sha2)}..HEAD`) {
          return { code: 0, stderr: "", stdout: "1\n" };
        }

        throw new Error(`unexpected exec: ${bin} ${argStr}`);
      },
    );
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect({
      collapseAnchorId: runtime.collapseAnchorId,
      cycleActions: runtime.cycleActions,
      cycleComplete: runtime.cycleComplete,
      evalPending: runtime.evalPending,
      mutationDetected: runtime.mutationDetected,
      sendUserMessageCalls: sendUserMessage.mock.calls.length,
    }).toStrictEqual({
      collapseAnchorId: Option.none(),
      cycleActions: ["Verified task completion"],
      cycleComplete: true,
      evalPending: false,
      mutationDetected: false,
      sendUserMessageCalls: 0,
    });
  });

  it("sends the eval message after factoring convergence (no early return)", async () => {
    // Regression: when the agent responds to a factoring nudge
    // without changing HEAD (no factoring needed), checkConvergence
    // dispatched FactoringConverged but the handler returned early,
    // skipping runEvalOrComplete. The collapse mechanism then never
    // fired at the end of the cycle.
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.WaitingForFactoring({
      attempts: attempt(1),
      priorHeadSHA: sha1,
    });
    const cmd = Either.getOrThrow(decodeGateCommand("just check"));
    runtime.gateConfig = Option.some({ commands: [cmd], description: "test" });
    runtime.mutationDetected = true;
    runtime.reviewComplete = true;
    runtime.lastCleanCommitSHA = Option.some(sha1);

    const { pi, sendUserMessage } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockImplementation(
      async (_bin: string, args: ReadonlyArray<string>) => {
        const argStr = args.join(" ");
        if (argStr === "rev-parse HEAD") {
          return { code: 0, stderr: "", stdout: String(sha1) + "\n" };
        }
        if (argStr.includes("rev-list")) {
          return { code: 0, stderr: "", stdout: "0\n" };
        }
        return { code: 0, stderr: "", stdout: "" };
      },
    );
    const { ctx } = makeCtx();

    await handleAgentEnd(pi, runtime, ctx);

    expect(runtime.evalPending).toStrictEqual(true);
    expect(sendUserMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getAttempts — defensive exhaustive arms
// ---------------------------------------------------------------------------

describe("getAttempts", () => {
  it("returns 0 for Idle", () => {
    expect(Number(getAttempts(CleanupState.Idle()))).toStrictEqual(0);
  });

  it("returns the stored attempts for WaitingForTreeFix", () => {
    const s = CleanupState.WaitingForTreeFix({ attempts: attempt(3) });
    expect(Number(getAttempts(s))).toStrictEqual(3);
  });

  it("returns the stored attempts for WaitingForGateFix", () => {
    const cmd = Either.getOrThrow(decodeGateCommand("npm test"));
    const s = CleanupState.WaitingForGateFix({ attempts: attempt(2), failedGate: cmd });
    expect(Number(getAttempts(s))).toStrictEqual(2);
  });

  it("returns the stored attempts for WaitingForFactoring", () => {
    const s = CleanupState.WaitingForFactoring({ attempts: attempt(4), priorHeadSHA: sha1 });
    expect(Number(getAttempts(s))).toStrictEqual(4);
  });

  it("returns 0 for AwaitingUserInput (defensive; unreachable via handler)", () => {
    // The handler gates on isActionable, so AwaitingUserInput never
    // Reaches getAttempts in production. The arm exists to satisfy
    // Match.exhaustive; this test keeps absolute coverage honest.
    const s = CleanupState.AwaitingUserInput({ reason: AwaitingReason.GatesUnconfigured() });
    expect(Number(getAttempts(s))).toStrictEqual(0);
  });

  it("returns 0 for Disabled (defensive; unreachable via handler)", () => {
    expect(Number(getAttempts(CleanupState.Disabled()))).toStrictEqual(0);
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

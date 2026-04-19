import { describe, expect, it, vi } from "vitest";
import { Either, Option } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { isGitUnchanged, resolveBaseSHA } from "../src/phases/git-status.js";
import { isCycleInProgress } from "../src/pipeline.js";
import { getCommitCount, runReviewIfNeeded } from "../src/pipeline-review.js";
import { createInitialRuntimeState } from "../src/runtime.js";
import { decodeCommitSHA } from "../src/types.js";

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
      commitCount: 3,
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
      commitCount: 1,
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
// isGitUnchanged
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getCommitCount
// ---------------------------------------------------------------------------

describe("getCommitCount", () => {
  it("returns 0 when HEAD is invalid", async () => {
    const { pi } = makePi();
    const result = await getCommitCount(pi, Either.left("bad"), Option.some(sha1));
    expect(result).toStrictEqual(0);
  });

  it("returns 0 when baseSHA is None", async () => {
    const { pi } = makePi();
    const result = await getCommitCount(pi, Either.right(sha1), Option.none());
    expect(result).toStrictEqual(0);
  });

  it("returns parsed count from rev-list", async () => {
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "5\n",
    });
    const result = await getCommitCount(pi, Either.right(sha1), Option.some(sha2));
    expect(result).toStrictEqual(5);
  });

  it("returns 0 when rev-list output is not a number", async () => {
    const { pi } = makePi();
    (pi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stderr: "",
      stdout: "not-a-number\n",
    });
    const result = await getCommitCount(pi, Either.right(sha1), Option.some(sha2));
    expect(result).toStrictEqual(0);
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

import { describe, expect, it, vi } from "vitest";
import { Either, Option } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { runReviewIfNeeded } from "../src/pipeline.js";
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

// ---------------------------------------------------------------------------
// runReviewIfNeeded
// ---------------------------------------------------------------------------

describe("runReviewIfNeeded", () => {
  it("returns false when review is already complete", () => {
    const runtime = createInitialRuntimeState();
    runtime.reviewComplete = true;
    const { pi, sendUserMessage } = makePi();
    const { ctx } = makeCtx();

    const result = runReviewIfNeeded(
      { ctx, pi, runtime },
      Either.right(sha1),
      Option.some(sha2),
    );
    expect(result).toStrictEqual(false);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("returns false when HEAD is invalid", () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    const { ctx } = makeCtx();

    const result = runReviewIfNeeded(
      { ctx, pi, runtime },
      Either.left("invalid"),
      Option.some(sha2),
    );
    expect(result).toStrictEqual(false);
  });

  it("returns false when baseSHA is None", () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    const { ctx } = makeCtx();

    const result = runReviewIfNeeded(
      { ctx, pi, runtime },
      Either.right(sha1),
      Option.none(),
    );
    expect(result).toStrictEqual(false);
  });

  it("sends review message and returns true on first call", () => {
    const runtime = createInitialRuntimeState();
    const { pi, sendUserMessage } = makePi();
    const { ctx } = makeCtx();

    const result = runReviewIfNeeded(
      { ctx, pi, runtime },
      Either.right(sha1),
      Option.some(sha2),
    );
    expect(result).toStrictEqual(true);
    expect(runtime.reviewPending).toStrictEqual(true);
    expect(sendUserMessage).toHaveBeenCalled();
  });

  it("marks review complete and returns false on second call", () => {
    const runtime = createInitialRuntimeState();
    runtime.reviewPending = true;
    const { pi } = makePi();
    const { ctx } = makeCtx();

    const result = runReviewIfNeeded(
      { ctx, pi, runtime },
      Either.right(sha1),
      Option.some(sha2),
    );
    expect(result).toStrictEqual(false);
    expect(runtime.reviewComplete).toStrictEqual(true);
    expect(runtime.reviewPending).toStrictEqual(false);
  });

  it("captures collapse anchor on first call", () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    const { ctx } = makeCtx("leaf-456");

    runReviewIfNeeded(
      { ctx, pi, runtime },
      Either.right(sha1),
      Option.some(sha2),
    );
    expect(Option.isSome(runtime.collapseAnchorId)).toStrictEqual(true);
  });

  it("records action in cycleActions", () => {
    const runtime = createInitialRuntimeState();
    const { pi } = makePi();
    const { ctx } = makeCtx();

    runReviewIfNeeded(
      { ctx, pi, runtime },
      Either.right(sha1),
      Option.some(sha2),
    );
    expect(runtime.cycleActions).toContain("Delegated code review to subagent");
  });
});

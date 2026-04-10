import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeCommitSHA, decodeGateCommand, decodeAttemptCount, incrementAttempt } from "../src/types.js";

describe("CommitSHA", () => {
  it("accepts valid 40-char lowercase hex", () => {
    expect(Either.isRight(decodeCommitSHA("a".repeat(40)))).toStrictEqual(true);
  });

  it("rejects uppercase hex", () => {
    expect(Either.isLeft(decodeCommitSHA("A".repeat(40)))).toStrictEqual(true);
  });

  it("rejects wrong length", () => {
    expect(Either.isLeft(decodeCommitSHA("abcdef"))).toStrictEqual(true);
  });
});

describe("GateCommand", () => {
  it("accepts non-empty trimmed string", () => {
    expect(Either.isRight(decodeGateCommand("echo ok"))).toStrictEqual(true);
  });

  it("rejects empty string", () => {
    expect(Either.isLeft(decodeGateCommand(""))).toStrictEqual(true);
  });
});

describe("AttemptCount", () => {
  it("accepts zero", () => {
    expect(Either.isRight(decodeAttemptCount(0))).toStrictEqual(true);
  });

  it("rejects negative", () => {
    expect(Either.isLeft(decodeAttemptCount(-1))).toStrictEqual(true);
  });

  it("increments correctly", () => {
    const two = Either.getOrThrow(decodeAttemptCount(2));
    expect(incrementAttempt(two)).toStrictEqual(3);
  });
});

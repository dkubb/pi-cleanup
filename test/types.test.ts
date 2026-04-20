import { describe, expect, it } from "vitest";
import { Either, Schema } from "effect";
import {
  CommitCount,
  decodeAttemptCount,
  decodeCommitCount,
  decodeCommitSHA,
  decodeGateCommand,
  incrementAttempt,
} from "../src/types.js";

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

describe("CommitCount", () => {
  const commitCount = (input: string) => Schema.decodeUnknownSync(CommitCount)(input);

  it("accepts \"0\"", () => {
    expect(decodeCommitCount("0")).toStrictEqual(Either.right(commitCount("0")));
  });

  it("accepts \"1\"", () => {
    expect(decodeCommitCount("1")).toStrictEqual(Either.right(commitCount("1")));
  });

  it("accepts \"42\"", () => {
    expect(decodeCommitCount("42")).toStrictEqual(Either.right(commitCount("42")));
  });

  it("rejects \"00\"", () => {
    expect(decodeCommitCount("00")._tag).toStrictEqual("Left");
  });

  it("rejects \"007\"", () => {
    expect(decodeCommitCount("007")._tag).toStrictEqual("Left");
  });

  it("rejects \"01\"", () => {
    expect(decodeCommitCount("01")._tag).toStrictEqual("Left");
  });

  it("rejects \"-1\"", () => {
    expect(decodeCommitCount("-1")._tag).toStrictEqual("Left");
  });

  it("rejects \"1.5\"", () => {
    expect(decodeCommitCount("1.5")._tag).toStrictEqual("Left");
  });

  it("rejects \"abc\"", () => {
    expect(decodeCommitCount("abc")._tag).toStrictEqual("Left");
  });

  it("rejects an empty string", () => {
    expect(decodeCommitCount("")._tag).toStrictEqual("Left");
  });

  it("rejects whitespace-padded strings", () => {
    expect(decodeCommitCount(" 5 ")._tag).toStrictEqual("Left");
  });
});

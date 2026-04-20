import { describe, expect, it } from "vitest";
import { Either, ParseResult, Schema } from "effect";
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

  it("accepts leading-zero strings", () => {
    expect(decodeCommitCount("007")).toStrictEqual(Either.right(commitCount("007")));
  });

  it("rejects \"-1\"", () => {
    const result = decodeCommitCount("-1");

    expect(result._tag).toStrictEqual("Left");
    expect(Either.isLeft(result) && ParseResult.isParseError(result.left)).toStrictEqual(true);
  });

  it("rejects \"1.5\"", () => {
    const result = decodeCommitCount("1.5");

    expect(result._tag).toStrictEqual("Left");
    expect(Either.isLeft(result) && ParseResult.isParseError(result.left)).toStrictEqual(true);
  });

  it("rejects \"abc\"", () => {
    const result = decodeCommitCount("abc");

    expect(result._tag).toStrictEqual("Left");
    expect(Either.isLeft(result) && ParseResult.isParseError(result.left)).toStrictEqual(true);
  });

  it("rejects an empty string", () => {
    const result = decodeCommitCount("");

    expect(result._tag).toStrictEqual("Left");
    expect(Either.isLeft(result) && ParseResult.isParseError(result.left)).toStrictEqual(true);
  });

  it("rejects whitespace-padded strings", () => {
    const result = decodeCommitCount(" 5 ");

    expect(result._tag).toStrictEqual("Left");
    expect(Either.isLeft(result) && ParseResult.isParseError(result.left)).toStrictEqual(true);
  });
});

import { describe, expect, it } from "vitest";
import { Either } from "effect";

import { buildReviewCommand, buildReviewMessage } from "../../src/phases/review.js";
import { decodeCommitSHA } from "../../src/types.js";

const sha1 = Either.getOrThrow(decodeCommitSHA("a".repeat(40)));
const sha2 = Either.getOrThrow(decodeCommitSHA("b".repeat(40)));

describe("buildReviewCommand", () => {
  it("uses git show for a single commit", () => {
    const cmd = buildReviewCommand(sha1, sha2, 1);
    expect(cmd).toStrictEqual(`git --no-pager show ${"b".repeat(40)}`);
  });

  it("uses git log --patch for multiple commits", () => {
    const cmd = buildReviewCommand(sha1, sha2, 3);
    expect(cmd).toStrictEqual(
      `git --no-pager log --patch ${"a".repeat(40)}..${"b".repeat(40)}`,
    );
  });
});

describe("buildReviewMessage", () => {
  it("includes the commit range", () => {
    const msg = buildReviewMessage(sha1, sha2, 2);
    expect(msg).toContain(`\`${"a".repeat(40)}..${"b".repeat(40)}\``);
  });

  it("includes commit count label for single commit", () => {
    const msg = buildReviewMessage(sha1, sha2, 1);
    expect(msg).toContain("1 commit");
  });

  it("includes commit count label for multiple commits", () => {
    const msg = buildReviewMessage(sha1, sha2, 5);
    expect(msg).toContain("5 commits");
  });

  it("includes code quality review instructions", () => {
    const msg = buildReviewMessage(sha1, sha2, 2);
    expect(msg).toContain("Code quality");
  });

  it("includes commit message validation instructions", () => {
    const msg = buildReviewMessage(sha1, sha2, 2);
    expect(msg).toContain("Commit messages");
    expect(msg).toContain("conventional commit format");
  });

  it("includes overall structure review", () => {
    const msg = buildReviewMessage(sha1, sha2, 2);
    expect(msg).toContain("Overall structure");
  });

  it("uses git show command for single commit", () => {
    const msg = buildReviewMessage(sha1, sha2, 1);
    expect(msg).toContain("git --no-pager show");
  });

  it("uses git log --patch command for multiple commits", () => {
    const msg = buildReviewMessage(sha1, sha2, 3);
    expect(msg).toContain("git --no-pager log --patch");
  });
});

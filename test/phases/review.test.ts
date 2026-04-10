import { describe, expect, it } from "vitest";
import { Either } from "effect";

import { buildReviewMessage } from "../../src/phases/review.js";
import { decodeCommitSHA } from "../../src/types.js";

const sha1 = Either.getOrThrow(decodeCommitSHA("a".repeat(40)));
const sha2 = Either.getOrThrow(decodeCommitSHA("b".repeat(40)));

describe("buildReviewMessage", () => {
  it("includes the commit range", () => {
    const msg = buildReviewMessage(sha1, sha2);
    expect(msg).toContain(`\`${"a".repeat(40)}..${"b".repeat(40)}\``);
  });

  it("includes subagent delegation instructions", () => {
    const msg = buildReviewMessage(sha1, sha2);
    expect(msg).toContain("delegate a code review to a subagent");
  });

  it("includes the diff command", () => {
    const msg = buildReviewMessage(sha1, sha2);
    expect(msg).toContain("git --no-pager diff");
  });
});

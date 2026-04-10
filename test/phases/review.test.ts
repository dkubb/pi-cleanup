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
  it("returns the exact expected message for a single commit", () => {
    const msg = buildReviewMessage(sha1, sha2, 1);

    expect(msg).toStrictEqual(
      [
        `Code review required before atomizing commits (1 commit).`,
        "",
        `Commit range: \`${"a".repeat(40)}..${"b".repeat(40)}\``,
        "",
        "Please delegate a holistic code review to a subagent:",
        "",
        "**Code quality:**",
        "- Review the diff for correctness, edge cases, and style",
        "- Check for any regressions or incomplete changes",
        "",
        "**Commit messages:**",
        "- Load the git-commit skill and validate messages against it",
        "- Ensure each commit has a single clear purpose",
        "",
        "**Overall structure:**",
        "- Verify changes are cohesive and well-organized",
        "- Flag any concerns about the approach",
        "",
        `Use \`git --no-pager show ${"b".repeat(40)}\` to see the changes.`,
        "",
        "Address any issues found, then confirm the review passed.",
      ].join("\n"),
    );
  });

  it("returns the exact expected message for multiple commits", () => {
    const msg = buildReviewMessage(sha1, sha2, 5);

    expect(msg).toStrictEqual(
      [
        `Code review required before atomizing commits (5 commits).`,
        "",
        `Commit range: \`${"a".repeat(40)}..${"b".repeat(40)}\``,
        "",
        "Please delegate a holistic code review to a subagent:",
        "",
        "**Code quality:**",
        "- Review the diff for correctness, edge cases, and style",
        "- Check for any regressions or incomplete changes",
        "",
        "**Commit messages:**",
        "- Load the git-commit skill and validate messages against it",
        "- Ensure each commit has a single clear purpose",
        "",
        "**Overall structure:**",
        "- Verify changes are cohesive and well-organized",
        "- Flag any concerns about the approach",
        "",
        `Use \`git --no-pager log --patch ${"a".repeat(40)}..${"b".repeat(40)}\` to see the changes.`,
        "",
        "Address any issues found, then confirm the review passed.",
      ].join("\n"),
    );
  });
});

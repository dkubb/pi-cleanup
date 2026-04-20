/**
 * Code review phase.
 *
 * Builds a message asking the agent to delegate a holistic code
 * review to a subagent before commits are atomized.
 *
 * @module
 */

import type { CommitCount, CommitSHA } from "../types.js";

/**
 * Format a human-readable commit count label.
 *
 * @param count - Number of commits.
 * @returns Formatted label.
 */
const formatCommitLabel = (count: CommitCount): string => {
  const countText = String(count);

  if (count === 1) {
    return `${countText} commit`;
  }

  return `${countText} commits`;
};

// ---------------------------------------------------------------------------
// Review Message
// ---------------------------------------------------------------------------

/**
 * Build the git command for viewing the changes under review.
 *
 * Uses `git show` for a single commit and `git log --patch` for
 * multiple commits, so the reviewer sees both code and messages.
 *
 * @param baseSHA - The base SHA for the review range.
 * @param headSHA - The HEAD SHA for the review range.
 * @param commitCount - Number of commits in the range.
 * @returns A git command string.
 */
export const buildReviewCommand = (
  baseSHA: CommitSHA,
  headSHA: CommitSHA,
  commitCount: CommitCount,
): string => {
  if (commitCount === 1) {
    return `git --no-pager show ${String(headSHA)}`;
  }

  return `git --no-pager log --patch ${String(baseSHA)}..${String(headSHA)}`;
};

/**
 * Build a message asking the agent to run a subagent code review.
 *
 * The review is holistic: code quality, commit messages, and
 * overall structure. Includes the appropriate git command based
 * on whether this is a single commit or a range.
 *
 * @param baseSHA - The base SHA for the review range.
 * @param headSHA - The HEAD SHA for the review range.
 * @param commitCount - Number of commits in the range.
 * @returns A formatted message string for `sendUserMessage`.
 */
export const buildReviewMessage = (
  baseSHA: CommitSHA,
  headSHA: CommitSHA,
  commitCount: CommitCount,
): string => {
  const commitLabel = formatCommitLabel(commitCount);
  const reviewCmd = buildReviewCommand(baseSHA, headSHA, commitCount);

  return [
    `Code review required before atomizing commits (${commitLabel}).`,
    "",
    `Commit range: \`${String(baseSHA)}..${String(headSHA)}\``,
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
    `Use \`${reviewCmd}\` to see the changes.`,
    "",
    "Address any issues found, then confirm the review passed.",
  ].join("\n");
};

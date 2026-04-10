/**
 * Code review phase.
 *
 * Builds a message asking the agent to delegate a code review
 * to a subagent before commits are atomized.
 *
 * @module
 */

import type { CommitSHA } from "../types.js";

// ---------------------------------------------------------------------------
// Review Message
// ---------------------------------------------------------------------------

/**
 * Build a message asking the agent to run a subagent code review.
 *
 * Includes the commit range so the reviewer knows what to examine.
 * The review runs before atomicity so commits are in natural form.
 *
 * @param baseSHA - The base SHA for the review range.
 * @param headSHA - The HEAD SHA for the review range.
 * @returns A formatted message string for `sendUserMessage`.
 */
export const buildReviewMessage = (baseSHA: CommitSHA, headSHA: CommitSHA): string =>
  [
    "Code review required before atomizing commits.",
    "",
    `Commit range: \`${String(baseSHA)}..${String(headSHA)}\``,
    "",
    "Please delegate a code review to a subagent:",
    "1. Have the subagent review the diff for this commit range",
    "2. Address any issues found by the review",
    "3. If no issues, confirm the review passed",
    "",
    `Use \`git --no-pager diff ${String(baseSHA)}..${String(headSHA)}\` to see the changes.`,
  ].join("\n");

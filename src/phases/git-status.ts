/**
 * Git state change detection.
 *
 * Provides a precise check for whether git state has changed since
 * the last completed cleanup cycle, avoiding unnecessary pipeline
 * runs when mutation tools didn't actually affect the repository.
 *
 * @module
 */

import { Either, Option } from "effect";

import { getDefaultBaseSHA } from "./atomicity.js";
import { type CommitSHA, decodeCommitSHA, type ExecFn } from "../types.js";

/**
 * Check whether git state has actually changed since last cycle.
 *
 * Even when mutationDetected is true, the mutations may not have
 * affected git state (e.g. a bash command that only read files).
 * Compares HEAD to lastCleanCommitSHA and checks for dirty tree.
 *
 * @param exec - The injected exec function.
 * @param lastCleanSHA - The last clean commit SHA.
 * @returns True if nothing changed and pipeline should skip.
 */
export const isGitUnchanged = async (
  exec: ExecFn,
  lastCleanSHA: Option.Option<CommitSHA>,
): Promise<boolean> => {
  if (Option.isNone(lastCleanSHA)) {
    return false;
  }

  const headResult = await exec("git", ["rev-parse", "HEAD"]);
  const headEither = decodeCommitSHA(headResult.stdout.trim());

  if (Either.isLeft(headEither)) {
    return false;
  }

  if (String(headEither.right) !== String(lastCleanSHA.value)) {
    return false;
  }

  const statusResult = await exec("git", ["status", "--porcelain"]);

  if (statusResult.code !== 0) {
    return false;
  }

  return statusResult.stdout.trim().length === 0;
};

/**
 * Resolve the base SHA for review and atomicity phases.
 *
 * Uses lastCleanCommitSHA if available, otherwise falls back
 * to the default branch merge-base.
 *
 * @param exec - The injected exec function.
 * @param lastCleanSHA - The last clean commit SHA.
 * @returns The base SHA, or None if indeterminate.
 */
export const resolveBaseSHA = async (
  exec: ExecFn,
  lastCleanSHA: Option.Option<CommitSHA>,
): Promise<Option.Option<CommitSHA>> => {
  if (Option.isSome(lastCleanSHA)) {
    return lastCleanSHA;
  }

  return getDefaultBaseSHA(exec);
};

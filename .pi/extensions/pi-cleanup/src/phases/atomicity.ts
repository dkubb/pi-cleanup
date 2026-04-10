/**
 * Commit atomicity check, base SHA utility, and factor messaging.
 *
 * Determines whether recent commits need splitting via git-factor by
 * counting commits between a base SHA and HEAD.
 *
 * @module
 */

import { Data, type Option } from "effect";

import type { CommitSHA, ExecFn, GateCommand } from "../types.js";

// ---------------------------------------------------------------------------
// Base SHA Utility
// ---------------------------------------------------------------------------

/** Default branch names to try when determining the merge base. */
// @ts-expect-error -- Stub: used by getDefaultBaseSHA once implemented
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const DEFAULT_BRANCHES = ["main", "master", "develop"] as const;

/**
 * Find the merge-base SHA between HEAD and a default branch.
 *
 * Tries `git merge-base HEAD {branch}` for each of main, master,
 * develop in order. Returns the first valid result as
 * `Option.Some<CommitSHA>`, or `Option.None` if no default branch
 * exists.
 *
 * Returns Option (not Either) because "no base found" is a valid
 * state, not an error.
 *
 * @param _exec - The injected exec function (pi.exec signature).
 * @returns The merge-base SHA if found, or None.
 *
 * @example
 * ```ts
 * import { Option } from "effect";
 *
 * // Found main branch
 * const exec = async (_cmd, args) =>
 *   args.includes("main")
 *     ? { code: 0, stdout: "a".repeat(40), stderr: "" }
 *     : { code: 1, stdout: "", stderr: "" };
 * const result = await getDefaultBaseSHA(exec);
 * assert(Option.isSome(result));
 *
 * // No default branches exist
 * const noExec = async () => ({ code: 1, stdout: "", stderr: "" });
 * const none = await getDefaultBaseSHA(noExec);
 * assert(Option.isNone(none));
 * ```
 */
export const getDefaultBaseSHA = async (_exec: ExecFn): Promise<Option.Option<CommitSHA>> => {
  // What: Try merge-base with main, master, develop in order.
  // Why: Need a base SHA to count commits for atomicity checking.
  //      Different projects use different default branch names.
  // How: For each branch in DEFAULT_BRANCHES:
  //        Exec("git", ["merge-base", "HEAD", branch])
  //        If code === 0, validate output with decodeCommitSHA.
  //        If valid, return Option.some(sha).
  //        If invalid or non-zero, try next branch.
  //      If none match, return Option.none().

  // TODO: Implement
  throw new Error("Not implemented");
};

// ---------------------------------------------------------------------------
// Atomicity Check
// ---------------------------------------------------------------------------

/**
 * Result of checking commit atomicity.
 *
 * - `Atomic`: One or fewer commits since base — already atomic.
 * - `NoBase`: No base SHA determinable — skip factoring.
 * - `NeedsFactoring`: Multiple commits that may need splitting.
 */
export type AtomicityResult = Data.TaggedEnum<{
  /** Commits are already atomic (≤1 commit since base). */
  readonly Atomic: { readonly headSHA: CommitSHA };
  /** No base SHA determinable — cannot assess atomicity. */
  readonly NoBase: { readonly headSHA: CommitSHA };
  /** HEAD could not be determined — skip atomicity check entirely. */
  readonly Indeterminate: {};
  /** Multiple commits exist that may need splitting. */
  readonly NeedsFactoring: {
    readonly headSHA: CommitSHA;
    readonly baseSHA: CommitSHA;
    readonly commitCount: number;
  };
}>;

/** Constructor namespace for {@link AtomicityResult} variants. */
export const AtomicityResult = Data.taggedEnum<AtomicityResult>();

/**
 * Check whether recent commits need splitting for atomicity.
 *
 * Gets HEAD SHA, determines base (from lastCleanSHA or default branch),
 * and counts commits in the range. One or fewer commits is atomic.
 * If HEAD can't be parsed (shouldn't happen after the dirty-tree check
 * confirmed a repo), falls back to a zero SHA and reports Atomic.
 *
 * @param _exec - The injected exec function (pi.exec signature).
 * @param _lastCleanSHA - The last known clean commit SHA, or None.
 * @returns A tagged result: Atomic, NoBase, or NeedsFactoring.
 *
 * @example
 * ```ts
 * import { Option } from "effect";
 *
 * // Single commit → atomic
 * const exec = async (_cmd, args) => {
 *   if (args.includes("rev-parse")) return { code: 0, stdout: "a".repeat(40), stderr: "" };
 *   if (args.includes("--count")) return { code: 0, stdout: "1", stderr: "" };
 *   return { code: 0, stdout: "b".repeat(40), stderr: "" };
 * };
 * const result = await checkAtomicity(exec, Option.none());
 * assert(result._tag === "Atomic");
 * ```
 */
export const checkAtomicity = async (
  _exec: ExecFn,
  _lastCleanSHA: Option.Option<CommitSHA>,
): Promise<AtomicityResult> => {
  // What: Determine if recent commits need factoring.
  // Why: Atomic commits improve reviewability and bisectability.
  //      This only runs after gates pass, so the code is known-good.
  // How:
  //   1. Get HEAD SHA via exec("git", ["rev-parse", "HEAD"]).
  //      Validate with decodeCommitSHA. If invalid, return Indeterminate
  //      (do not fabricate a SHA or persist anything).
  //   2. Determine base: use lastCleanSHA if Some, else getDefaultBaseSHA(exec).
  //      If None, return NoBase.
  //   3. Count commits: exec("git", ["rev-list", "--count", `${base}..HEAD`]).
  //      Parse as integer. If ≤1 or NaN, return Atomic.
  //      If >1, return NeedsFactoring with headSHA, baseSHA, commitCount.

  // TODO: Implement
  throw new Error("Not implemented");
};

/**
 * Build a user message asking the agent to factor commits.
 *
 * Instructs the agent to apply the git-factor skill with the commit
 * range and gate commands as the --exec validation gate.
 *
 * @param _baseSHA - The base commit SHA (start of range).
 * @param _headSHA - The HEAD commit SHA (end of range).
 * @param _gateCommands - Gate commands to use as the --exec validation gate.
 * @returns A formatted message string for `sendUserMessage`.
 *
 * @example
 * ```ts
 * const msg = buildFactorMessage(baseSHA, headSHA, [gateCommand("npm test")]);
 * assert(msg.includes("git-factor"));
 * assert(msg.includes("--exec"));
 * ```
 */
export const buildFactorMessage = (
  _baseSHA: CommitSHA,
  _headSHA: CommitSHA,
  _gateCommands: readonly GateCommand[],
): string => {
  // What: Format a message instructing the agent to factor commits.
  // Why: The agent needs the commit range and exec gate to run git-factor.
  // How: Join lines with:
  //      - "All gates pass. Now ensure recent commits are atomic."
  //      - The commit range (short SHAs: first 8 chars)
  //      - Instruction to use git-factor skill
  //      - The --exec gate command (all gate commands joined with &&)
  //      - Instruction to confirm when done

  // TODO: Implement
  throw new Error("Not implemented");
};

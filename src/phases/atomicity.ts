/**
 * Commit atomicity check, base SHA utility, and factor messaging.
 *
 * Determines whether recent commits need splitting via git-factor by
 * counting commits between a base SHA and HEAD.
 *
 * @module
 */

import { Data, Either, Option } from "effect";

import { type CommitSHA, decodeCommitSHA, type ExecFn, type GateCommand } from "../types.js";

// ---------------------------------------------------------------------------
// Base SHA Utility
// ---------------------------------------------------------------------------

/** Default branch names to try when determining the merge base. */
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
 * @param exec - The injected exec function (pi.exec signature).
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
export const getDefaultBaseSHA = async (exec: ExecFn): Promise<Option.Option<CommitSHA>> => {
  // Branches must be tried sequentially — we want the first match
  // In priority order (main > master > develop), not all of them.
  for (const branch of DEFAULT_BRANCHES) {
    // eslint-disable-next-line no-await-in-loop -- sequential priority order
    const result = await exec("git", ["merge-base", "HEAD", branch]);

    if (result.code === 0) {
      const maybeSHA = Either.getRight(decodeCommitSHA(result.stdout.trim()));

      if (Option.isSome(maybeSHA)) {
        return maybeSHA;
      }
    }
  }

  return Option.none();
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
 * Resolve the base SHA from session state or default branch.
 *
 * Uses the session-scoped lastCleanSHA when present, falling back
 * to the merge-base with a default branch.
 *
 * @param exec - The injected exec function.
 * @param lastCleanSHA - The last known clean commit SHA, or None.
 * @returns The resolved base SHA option.
 */
const resolveBaseSHA = (
  exec: ExecFn,
  lastCleanSHA: Option.Option<CommitSHA>,
): Promise<Option.Option<CommitSHA>> =>
  Option.match(lastCleanSHA, {
    onNone: (): Promise<Option.Option<CommitSHA>> => getDefaultBaseSHA(exec),
    onSome: (sha): Promise<Option.Option<CommitSHA>> => Promise.resolve(Option.some(sha)),
  });

/**
 * Classify the commit count between base and HEAD.
 *
 * @param exec - The injected exec function.
 * @param headSHA - The validated HEAD SHA.
 * @param baseSHA - The validated base SHA.
 * @returns Atomic if ≤1 commit, NeedsFactoring otherwise.
 */
const classifyCommitRange = async (
  exec: ExecFn,
  headSHA: CommitSHA,
  baseSHA: CommitSHA,
): Promise<AtomicityResult> => {
  const countResult = await exec("git", ["rev-list", "--count", `${String(baseSHA)}..HEAD`]);
  const count = Number.parseInt(countResult.stdout.trim(), 10);

  if (Number.isNaN(count) || count <= 1) {
    return AtomicityResult.Atomic({ headSHA });
  }

  return AtomicityResult.NeedsFactoring({
    baseSHA,
    commitCount: count,
    headSHA,
  });
};

/**
 * Check whether recent commits need splitting for atomicity.
 *
 * Gets HEAD SHA, determines base (from lastCleanSHA or default branch),
 * and counts commits in the range. One or fewer commits is atomic.
 *
 * @param exec - The injected exec function (pi.exec signature).
 * @param lastCleanSHA - The last known clean commit SHA, or None.
 * @returns A tagged result: Atomic, NoBase, Indeterminate, or NeedsFactoring.
 */
export const checkAtomicity = async (
  exec: ExecFn,
  lastCleanSHA: Option.Option<CommitSHA>,
): Promise<AtomicityResult> => {
  const headResult = await exec("git", ["rev-parse", "HEAD"]);

  return Either.match(decodeCommitSHA(headResult.stdout.trim()), {
    onLeft: () => AtomicityResult.Indeterminate(),
    onRight: async (headSHA) =>
      Option.match(await resolveBaseSHA(exec, lastCleanSHA), {
        onNone: () => AtomicityResult.NoBase({ headSHA }),
        onSome: (base) => {
          // When base equals HEAD (e.g., merge-base on the default
          // Branch), the range is empty and cannot detect non-atomic
          // Commits. Treat it the same as NoBase.
          if (String(base) === String(headSHA)) {
            return AtomicityResult.NoBase({ headSHA });
          }

          return classifyCommitRange(exec, headSHA, base);
        },
      }),
  });
};

/**
 * Build a user message asking the agent to factor commits.
 *
 * Instructs the agent to apply the git-factor skill with the commit
 * range and gate commands as the --exec validation gate.
 *
 * @param baseSHA - The base commit SHA (start of range).
 * @param headSHA - The HEAD commit SHA (end of range).
 * @param gateCommands - Gate commands to use as the --exec validation gate.
 * @returns A formatted message string for `sendUserMessage`.
 */
export const buildFactorMessage = (
  baseSHA: CommitSHA,
  headSHA: CommitSHA,
  gateCommands: readonly GateCommand[],
): string => {
  const gateExec = gateCommands.map(String).join(" && ");
  const shortBase = String(baseSHA).slice(0, 8);
  const shortHead = String(headSHA).slice(0, 8);

  return [
    "All gates pass. Now ensure recent commits are atomic.",
    "",
    `Commits in range: \`${shortBase}..${shortHead}\``,
    "",
    "Use the git-factor skill to split any commits that mix",
    "multiple logical changes.",
    `Use \`--exec '${gateExec}'\` as the validation gate.`,
    "",
    "After factoring (or if no factoring needed), confirm done.",
  ].join("\n");
};

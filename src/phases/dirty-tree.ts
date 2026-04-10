/**
 * Dirty tree detection and fix messaging.
 *
 * Checks `git status --porcelain=v1` and produces a tagged result.
 * If dirty, builds a message asking the agent to commit.
 *
 * @module
 */

import { Data } from "effect";

import type { ExecFn } from "../types.js";

// ---------------------------------------------------------------------------
// Dirty Tree Detection
// ---------------------------------------------------------------------------

/**
 * Result of checking the working tree status.
 *
 * - `Clean`: No uncommitted changes.
 * - `Dirty`: Uncommitted changes exist; `porcelain` is the raw output.
 * - `NotARepo`: git exited non-zero (not a repo or git error).
 */
export type GitStatusResult = Data.TaggedEnum<{
  /** Working tree is clean — no uncommitted changes. */
  readonly Clean: {};
  /** Working tree has uncommitted changes. */
  readonly Dirty: { readonly porcelain: string };
  /** Not a git repository (or git command failed). */
  readonly NotARepo: {};
}>;

/** Constructor namespace for {@link GitStatusResult} variants. */
export const GitStatusResult = Data.taggedEnum<GitStatusResult>();

/**
 * Check whether the current directory is inside a git repository.
 *
 * @param exec - The injected exec function (pi.exec signature).
 * @returns True if git commands will work in this directory.
 */
export const isGitRepo = async (exec: ExecFn): Promise<boolean> => {
  const result = await exec("git", ["rev-parse", "--git-dir"]);

  return result.code === 0;
};

/**
 * Check the working tree for uncommitted changes.
 *
 * Runs `git status --porcelain=v1` via the injected exec function.
 * Any non-zero exit code is treated as NotARepo (strict — if git
 * fails for any reason, we skip cleanup rather than risk acting on
 * incomplete information).
 *
 * @param exec - The injected exec function (pi.exec signature).
 * @returns A tagged result indicating clean, dirty, or not-a-repo.
 *
 * @example
 * ```ts
 * // Clean repo
 * const mockExec = async () => ({ code: 0, stdout: "", stderr: "" });
 * const result = await checkGitStatus(mockExec);
 * assert(result._tag === "Clean");
 *
 * // Dirty repo
 * const dirtyExec = async () => ({ code: 0, stdout: "M foo.ts", stderr: "" });
 * const dirty = await checkGitStatus(dirtyExec);
 * assert(dirty._tag === "Dirty");
 *
 * // Not a repo
 * const noRepoExec = async () => ({ code: 128, stdout: "", stderr: "fatal" });
 * const noRepo = await checkGitStatus(noRepoExec);
 * assert(noRepo._tag === "NotARepo");
 * ```
 */
export const checkGitStatus = async (exec: ExecFn): Promise<GitStatusResult> => {
  const result = await exec("git", ["status", "--porcelain=v1"]);

  if (result.code !== 0) {
    return GitStatusResult.NotARepo();
  }

  const trimmed = result.stdout.trim();

  if (trimmed.length === 0) {
    return GitStatusResult.Clean();
  }

  return GitStatusResult.Dirty({ porcelain: trimmed });
};

/**
 * Build a user message asking the agent to commit dirty files.
 *
 * Includes the porcelain output in a fenced code block so the agent
 * knows exactly which files need attention.
 *
 * @param porcelain - The raw output from `git status --porcelain=v1`.
 * @returns A formatted message string for `sendUserMessage`.
 *
 * @example
 * ```ts
 * const msg = buildDirtyTreeMessage("M foo.ts\n?? bar.ts");
 * assert(msg.includes("M foo.ts"));
 * assert(msg.includes("```"));
 * assert(msg.includes("commit"));
 * ```
 */
export const buildDirtyTreeMessage = (porcelain: string): string =>
  [
    "All quality gates pass. There are uncommitted changes in the working tree.",
    "Please stage and commit all changes using proper conventional commit format.",
    "",
    "```",
    porcelain,
    "```",
  ].join("\n");

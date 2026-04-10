/**
 * Quality gate execution and fix messaging.
 *
 * Runs gate commands sequentially, stopping at the first failure.
 * Produces a tagged result and a fix message for the agent.
 *
 * @module
 */

import { Data } from "effect";

import type { ExecFn, GateCommand, GateConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Gate Execution
// ---------------------------------------------------------------------------

/**
 * Result of running quality gate commands.
 *
 * - `AllPassed`: Every gate command exited with code 0.
 * - `Failed`: A gate command exited non-zero; includes the command and output.
 */
export type GateResult = Data.TaggedEnum<{
  /** All gate commands passed successfully. */
  readonly AllPassed: {};
  /** A gate command failed. */
  readonly Failed: {
    readonly command: GateCommand;
    readonly output: string;
  };
}>;

/** Constructor namespace for {@link GateResult} variants. */
export const GateResult = Data.taggedEnum<GateResult>();

/**
 * Run quality gate commands sequentially.
 *
 * Executes each command in `config.commands` via `bash -c` with a
 * 120-second timeout. Stops at the first failure. Combines stdout
 * and stderr into a single output string for the failure report.
 *
 * @param exec - The injected exec function (pi.exec signature).
 * @param config - Gate configuration with ordered commands.
 * @returns A tagged result indicating all-passed or first failure.
 *
 * @example
 * ```ts
 * // All pass
 * const passExec = async () => ({ code: 0, stdout: "ok", stderr: "" });
 * const config = { commands: [gateCommand("true")], description: "test" };
 * const result = await runGates(passExec, config);
 * assert(result._tag === "AllPassed");
 *
 * // First failure
 * let callCount = 0;
 * const failExec = async () => {
 *   callCount++;
 *   return callCount === 2
 *     ? { code: 1, stdout: "error", stderr: "detail" }
 *     : { code: 0, stdout: "", stderr: "" };
 * };
 * const config2 = { commands: [gateCommand("a"), gateCommand("b")], description: "test" };
 * const fail = await runGates(failExec, config2);
 * assert(fail._tag === "Failed");
 * ```
 */
export const runGates = async (exec: ExecFn, config: GateConfig): Promise<GateResult> => {
  for (const cmd of config.commands) {
    // eslint-disable-next-line no-await-in-loop -- sequential fail-fast execution
    const result = await exec("bash", ["-c", cmd], { timeout: 120_000 });

    if (result.code !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();

      return GateResult.Failed({ command: cmd, output });
    }
  }

  return GateResult.AllPassed();
};

/**
 * Build a user message asking the agent to fix a gate failure.
 *
 * Includes the failed command and its output in fenced code blocks
 * so the agent has full context for the fix.
 *
 * @param command - The gate command that failed.
 * @param output - Combined stdout + stderr from the failed command.
 * @returns A formatted message string for `sendUserMessage`.
 *
 * @example
 * ```ts
 * const msg = buildGateFixMessage(gateCommand("npm test"), "FAIL: 2 tests");
 * assert(msg.includes("npm test"));
 * assert(msg.includes("FAIL: 2 tests"));
 * assert(msg.includes("```"));
 * ```
 */
export const buildGateFixMessage = (command: GateCommand, output: string): string =>
  [
    `Quality gate failed: \`${String(command)}\``,
    "",
    "```",
    output,
    "```",
    "",
    "Please fix the issue and commit the fix.",
  ].join("\n");

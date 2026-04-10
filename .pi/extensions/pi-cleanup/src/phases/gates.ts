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
 * @param _exec - The injected exec function (pi.exec signature).
 * @param _config - Gate configuration with ordered commands.
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
export const runGates = async (_exec: ExecFn, _config: GateConfig): Promise<GateResult> => {
  // What: Execute each gate command sequentially via bash -c.
  // Why: Gates validate code quality (format, lint, test). Sequential
  //      Execution with fail-fast avoids running later gates that may
  //      Depend on earlier ones passing.
  // How: For each cmd in config.commands:
  //        Exec("bash", ["-c", cmd], { timeout: 120_000 })
  //        If code !== 0, return Failed with command + combined output.
  //      If all pass, return AllPassed.

  // TODO: Implement
  throw new Error("Not implemented");
};

/**
 * Build a user message asking the agent to fix a gate failure.
 *
 * Includes the failed command and its output in fenced code blocks
 * so the agent has full context for the fix.
 *
 * @param _command - The gate command that failed.
 * @param _output - Combined stdout + stderr from the failed command.
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
export const buildGateFixMessage = (_command: GateCommand, _output: string): string => {
  // What: Format a message with the failed gate command and output.
  // Why: The agent needs to see which gate failed and its output to fix it.
  // How: Join lines: "Quality gate failed: `{command}`", blank, fenced code
  //      Block with output, blank, instruction to fix and commit.

  // TODO: Implement
  throw new Error("Not implemented");
};

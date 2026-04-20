/**
 * Prior-cycle completion recording.
 *
 * Each `WaitingFor*` state is a request the agent was asked to fulfil
 * last cycle. By observing the relevant git/gate state at this
 * cycle's entry, we can tell whether the request was honored and
 * push the corresponding `cycleActions` entry.
 *
 * This centralization is necessary because a phase further down the
 * pipeline may dispatch a fresh failure and short-circuit the
 * orchestrator before its own success branch ever runs — so we
 * cannot rely on the per-phase runners to record completion of the
 * *previous* cycle's work.
 *
 * @module
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Either, Option } from "effect";

import { warn } from "./logger.js";
import { checkAtomicity } from "./phases/atomicity.js";
import { checkGitStatus } from "./phases/dirty-tree.js";
import { runGates } from "./phases/gates.js";
import type { RuntimeState } from "./runtime.js";
import { decodeCommitSHA } from "./types.js";

const recordTreeFixIfCommitted = async (pi: ExtensionAPI, runtime: RuntimeState): Promise<void> => {
  const status = await checkGitStatus(pi.exec.bind(pi));

  if (status._tag === "Clean") {
    runtime.cycleActions.push("Committed uncommitted changes");
  }
};

const recordGateFixIfPassing = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  failedGate: string,
): Promise<void> => {
  if (Option.isNone(runtime.gateConfig)) {
    return;
  }

  const stillTracked = runtime.gateConfig.value.commands.some((cmd) => String(cmd) === failedGate);

  if (!stillTracked) {
    return;
  }

  const gates = await runGates(pi.exec.bind(pi), runtime.gateConfig.value);

  if (gates._tag === "AllPassed") {
    runtime.cycleActions.push(`Fixed failing gate: \`${failedGate}\``);
  }
};

const recordFactoringIfComplete = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  priorHeadSHA: string,
): Promise<void> => {
  const headResult = await pi.exec("git", ["rev-parse", "HEAD"]);
  const headEither = decodeCommitSHA(headResult.stdout.trim());

  if (Either.isLeft(headEither)) {
    warn(
      "recordFactoringIfComplete",
      `failed to parse HEAD SHA (exit=${String(headResult.code)}, stdout="${headResult.stdout.slice(0, 80)}")`,
    );
    return;
  }

  if (String(headEither.right) === priorHeadSHA) {
    return;
  }

  const atomicity = await checkAtomicity(pi.exec.bind(pi), runtime.lastCleanCommitSHA);

  if (atomicity._tag === "Atomic" || atomicity._tag === "NoBase") {
    runtime.cycleActions.push("Factored commits into atomic units");
  }
};

/**
 * Record any completion from the prior cycle based on the entry state.
 *
 * Dispatches on the current `cleanup` state to pick the right
 * observation: tree, gate, or factoring.
 *
 * @param pi - The extension API for exec.
 * @param runtime - The mutable runtime state.
 */
export const recordPriorCycleCompletion = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
): Promise<void> => {
  const entry = runtime.cleanup;

  if (entry._tag === "WaitingForTreeFix") {
    await recordTreeFixIfCommitted(pi, runtime);
    return;
  }

  if (entry._tag === "WaitingForGateFix") {
    await recordGateFixIfPassing(pi, runtime, String(entry.failedGate));
    return;
  }

  if (entry._tag === "WaitingForFactoring") {
    await recordFactoringIfComplete(pi, runtime, String(entry.priorHeadSHA));
  }
};

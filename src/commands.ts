/**
 * Slash command handlers for /gates and /cleanup.
 *
 * @module
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Either, Option } from "effect";

import { persistGateConfig, persistGatesClear } from "./persistence.js";
import type { RuntimeState } from "./runtime.js";
import { TransitionEvent, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";
import { type GateCommand, type GateConfig, decodeGateCommand } from "./types.js";

// ---------------------------------------------------------------------------
// /gates Subcommands
// ---------------------------------------------------------------------------

/**
 * Handle `/gates show`.
 *
 * @param runtime - The runtime state.
 * @param ctx - The command context.
 */
const handleGatesShow = (runtime: RuntimeState, ctx: ExtensionCommandContext): void => {
  Option.match(runtime.gateConfig, {
    onNone: () => ctx.ui.notify("No gates configured.", "info"),
    onSome: (config) =>
      ctx.ui.notify(
        `Gates (${String(config.commands.length)} commands):\n${config.commands.map(String).join("\n")}`,
        "info",
      ),
  });
};

/**
 * Handle `/gates clear`.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 * @param ctx - The command context.
 */
const handleGatesClear = (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionCommandContext,
): void => {
  runtime.gateConfig = Option.none();
  persistGatesClear(pi.appendEntry.bind(pi));
  ctx.ui.notify("Gates cleared.", "info");
};

/**
 * Parse and validate gate commands from editor input.
 *
 * @param input - The raw editor input.
 * @param ctx - The command context (for error notification).
 * @returns The validated GateConfig, or undefined on validation failure.
 */
const parseGateInput = (input: string, ctx: ExtensionCommandContext): GateConfig | undefined => {
  const lines = input.split("\n").filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    ctx.ui.notify("No commands entered. Gates not changed.", "warning");

    return undefined;
  }

  const commands: GateCommand[] = [];

  for (const line of lines) {
    const decoded = decodeGateCommand(line.trim());

    if (Either.isLeft(decoded)) {
      ctx.ui.notify(`Invalid gate command: "${line.trim()}"`, "error");

      return undefined;
    }

    commands.push(decoded.right);
  }

  const [first, ...rest] = commands;

  if (first === undefined) {
    return undefined;
  }

  return { commands: [first, ...rest], description: "User configured" };
};

/**
 * Handle `/gates` (no args): open editor to configure gates.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 * @param ctx - The command context.
 */
const handleGatesEditor = async (
  pi: ExtensionAPI,
  runtime: RuntimeState,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  const prefill = Option.match(runtime.gateConfig, {
    onNone: () => "",
    onSome: (config) => config.commands.map(String).join("\n"),
  });

  const input = await ctx.ui.editor("Quality Gates (one command per line)", prefill);

  if (input === undefined) {
    return;
  }

  const config = parseGateInput(input, ctx);

  if (config === undefined) {
    return;
  }

  runtime.gateConfig = Option.some(config);
  persistGateConfig(pi.appendEntry.bind(pi), config);

  if (runtime.cleanup._tag === "AwaitingUserInput") {
    runtime.cleanup = transition(runtime.cleanup, TransitionEvent.GatesConfigured());
    updateStatus(ctx, runtime.cleanup);
  }

  ctx.ui.notify(`Gates configured: ${String(config.commands.length)} commands.`, "info");
};

// ---------------------------------------------------------------------------
// /cleanup Subcommands
// ---------------------------------------------------------------------------

/** Context for dispatching a cleanup command event. */
interface CleanupCommandAction {
  readonly runtime: RuntimeState;
  readonly ctx: ExtensionCommandContext;
  readonly event: TransitionEvent;
}

/**
 * Dispatch a cleanup command event and update status.
 *
 * @param action - The command action context.
 * @param message - The notification message.
 */
const dispatchCleanupCommand = (action: CleanupCommandAction, message: string): void => {
  action.runtime.cleanup = transition(action.runtime.cleanup, action.event);
  updateStatus(action.ctx, action.runtime.cleanup);
  action.ctx.ui.notify(message, "info");
};

/**
 * Handle `/cleanup status` (default).
 *
 * @param runtime - The runtime state.
 * @param ctx - The command context.
 */
const handleCleanupStatus = (runtime: RuntimeState, ctx: ExtensionCommandContext): void => {
  const gateCount = Option.match(runtime.gateConfig, {
    onNone: () => "none",
    onSome: (config) => String(config.commands.length),
  });

  const lastSHA = Option.match(runtime.lastCleanCommitSHA, {
    onNone: () => "none",
    onSome: (sha) => String(sha).slice(0, 8),
  });

  ctx.ui.notify(
    `State: ${runtime.cleanup._tag}\nGates: ${gateCount}\nLast clean: ${lastSHA}`,
    "info",
  );
};

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

/**
 * Register the /gates command.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 */
/**
 * Store the command context for navigateTree collapse.
 *
 * @param runtime - The runtime state.
 * @param ctx - The command context to store.
 */
const storeCommandCtx = (runtime: RuntimeState, ctx: ExtensionCommandContext): void => {
  runtime.commandCtx = Option.some({ navigateTree: ctx.navigateTree.bind(ctx) });
};

export const registerGatesCommand = (pi: ExtensionAPI, runtime: RuntimeState): void => {
  pi.registerCommand("gates", {
    description: "Configure quality gate commands (no args: editor, show, clear)",
    handler: async (args, ctx) => {
      storeCommandCtx(runtime, ctx);
      const trimmed = args.trim();

      if (trimmed === "show") {
        handleGatesShow(runtime, ctx);

        return;
      }

      if (trimmed === "clear") {
        handleGatesClear(pi, runtime, ctx);

        return;
      }

      await handleGatesEditor(pi, runtime, ctx);
    },
  });
};

/**
 * Register the /cleanup command.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 */
export const registerCleanupCommand = (pi: ExtensionAPI, runtime: RuntimeState): void => {
  pi.registerCommand("cleanup", {
    description: "Control cleanup extension (on, off, resume, status)",
    handler: async (args, ctx) => {
      storeCommandCtx(runtime, ctx);
      const trimmed = args.trim();

      if (trimmed === "on") {
        dispatchCleanupCommand(
          { ctx, event: TransitionEvent.UserEnabled(), runtime },
          "Cleanup enabled.",
        );

        return;
      }

      if (trimmed === "off") {
        dispatchCleanupCommand(
          { ctx, event: TransitionEvent.UserDisabled(), runtime },
          "Cleanup disabled.",
        );

        return;
      }

      if (trimmed === "resume") {
        dispatchCleanupCommand(
          { ctx, event: TransitionEvent.UserResumed(), runtime },
          "Cleanup resumed.",
        );

        return;
      }

      // Status (default)
      handleCleanupStatus(runtime, ctx);
    },
  });
};

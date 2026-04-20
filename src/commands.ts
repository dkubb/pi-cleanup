/**
 * Slash command handlers for /gates and /cleanup.
 *
 * @module
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Data, Either, Option } from "effect";
import { collapseIfNeeded } from "./pipeline-collapse.js";
import { persistGateConfig, persistGatesClear } from "./persistence.js";
import type { RuntimeState } from "./runtime.js";
import { TransitionEvent, transition } from "./state-machine.js";
import { updateStatus } from "./status.js";
import { type GateCommand, type GateConfig, decodeGateCommand } from "./types.js";

const GATES_CONFIGURE_SUBCOMMAND = "configure" as const;
const GATES_CONFIGURE_USAGE =
  "Usage: /gates configure <command>\nProvide one command per line for multiple gates.";

interface GatesCommandAction {
  readonly pi: ExtensionAPI;
  readonly runtime: RuntimeState;
  readonly ctx: ExtensionCommandContext;
}

/**
 * Reasons `parseGateInput` may fail to produce a GateConfig.
 */
export type ParseGateInputError = Data.TaggedEnum<{
  /** Input contained no non-blank lines. */
  readonly Empty: {};
  /** A line failed GateCommand validation. */
  readonly InvalidCommand: { readonly raw: string };
}>;

/** Constructor namespace for {@link ParseGateInputError} variants. */
export const ParseGateInputError = Data.taggedEnum<ParseGateInputError>();

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
 * Apply a validated gate configuration.
 *
 * @param action - The shared gates command action context.
 * @param config - The validated gate configuration.
 */
const applyGateConfig = (action: GatesCommandAction, config: GateConfig): void => {
  action.runtime.gateConfig = Option.some(config);
  persistGateConfig(action.pi.appendEntry.bind(action.pi), config);

  if (action.runtime.cleanup._tag === "AwaitingUserInput") {
    action.runtime.cleanup = transition(action.runtime.cleanup, TransitionEvent.GatesConfigured());
    updateStatus(action.ctx, action.runtime.cleanup);
  }

  action.ctx.ui.notify(`Gates configured: ${String(config.commands.length)} commands.`, "info");
};

/**
 * Parse and validate gate commands from raw input.
 *
 * Returns a typed error so callers can distinguish empty input from
 * an invalid command without relying on notification side effects.
 *
 * @param input - The raw gate input.
 * @returns Right(GateConfig) on success; Left(ParseGateInputError)
 *   naming the specific parse failure.
 */
export const parseGateInput = (input: string): Either.Either<GateConfig, ParseGateInputError> => {
  const lines = input.split("\n").map((line) => line.trim());

  if (lines.every((line) => line.length === 0)) {
    return Either.left(ParseGateInputError.Empty());
  }

  const [firstLine = "", ...restLines] = lines;
  const firstDecoded = decodeGateCommand(firstLine);

  if (Either.isLeft(firstDecoded)) {
    return Either.left(ParseGateInputError.InvalidCommand({ raw: firstLine }));
  }

  const restCommands: GateCommand[] = [];

  for (const line of restLines) {
    const decoded = decodeGateCommand(line);

    if (Either.isLeft(decoded)) {
      return Either.left(ParseGateInputError.InvalidCommand({ raw: line }));
    }

    restCommands.push(decoded.right);
  }

  return Either.right({
    commands: [firstDecoded.right, ...restCommands],
    description: "User configured",
  });
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

  const normalizedInput = input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");

  Either.match(parseGateInput(normalizedInput), {
    onLeft: (error) => {
      if (error._tag === "Empty") {
        ctx.ui.notify("No commands entered. Gates not changed.", "warning");
        return;
      }

      ctx.ui.notify(`Invalid gate command: "${error.raw}"`, "error");
    },
    onRight: (config) => {
      applyGateConfig({ ctx, pi, runtime }, config);
    },
  });
};

/**
 * Handle `/gates configure <commands>`.
 *
 * @param action - The shared command action context.
 * @param input - The raw configure input after the subcommand.
 */
const handleGatesConfigure = (action: GatesCommandAction, input: string): void => {
  if (input.trim().length === 0) {
    action.ctx.ui.notify(GATES_CONFIGURE_USAGE, "warning");

    return;
  }

  const normalizedInput = input
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");

  Either.match(parseGateInput(normalizedInput), {
    onLeft: (error) => {
      if (error._tag === "Empty") {
        action.ctx.ui.notify(GATES_CONFIGURE_USAGE, "warning");
        return;
      }

      action.ctx.ui.notify(`Invalid gate command: "${error.raw}"`, "error");
    },
    onRight: (config) => {
      applyGateConfig(action, config);
    },
  });
};

/** Context for dispatching a cleanup command event. */
interface CleanupCommandAction {
  readonly runtime: RuntimeState;
  readonly ctx: ExtensionCommandContext;
  readonly event: TransitionEvent;
}

interface CleanupCommandContextValue {
  readonly pi: ExtensionAPI;
  readonly runtime: RuntimeState;
  readonly ctx: ExtensionCommandContext;
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

const handleCleanupStatus = (runtime: RuntimeState, ctx: ExtensionCommandContext): void => {
  const gateCount = Option.match(runtime.gateConfig, {
    onNone: () => "none",
    onSome: (config) => String(config.commands.length),
  });

  const lastSHA = Option.match(runtime.lastCleanCommitSHA, {
    onNone: () => "none",
    onSome: (sha) => String(sha).slice(0, 8),
  });

  const pluginVersion = Option.getOrElse(runtime.pluginVersion, () => "unknown");

  ctx.ui.notify(
    `State: ${runtime.cleanup._tag}\nGates: ${gateCount}\nLast clean: ${lastSHA}\nVersion: ${pluginVersion}`,
    "info",
  );
};

const handleCleanupReload = async (
  pi: ExtensionAPI,
  _runtime: RuntimeState,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  ctx.ui.notify(
    "Reloading extension. A follow-up /cleanup status will report the loaded version.",
    "info",
  );
  pi.sendUserMessage("/cleanup status", { deliverAs: "followUp" });
  await ctx.reload();
};

/**
 * Handle `/cleanup collapse`.
 *
 * Performs the navigateTree collapse using the command context.
 * Called via sendUserMessage("/cleanup collapse") from the pipeline.
 *
 * @param runtime - The runtime state.
 * @param ctx - The command context with navigateTree.
 */
const handleCleanupCollapse = async (
  runtime: RuntimeState,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  runtime.commandCtx = Option.some({ navigateTree: ctx.navigateTree.bind(ctx) });

  const collapsed = await collapseIfNeeded(runtime);

  if (collapsed) {
    ctx.ui.notify("Cleanup context collapsed.", "info");
  }
};

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
    description: "Configure quality gate commands (no args: editor, show, clear, configure)",
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

      if (trimmed.startsWith(GATES_CONFIGURE_SUBCOMMAND)) {
        const input = trimmed.slice(GATES_CONFIGURE_SUBCOMMAND.length).trimStart();

        handleGatesConfigure({ ctx, pi, runtime }, input);

        return;
      }

      await handleGatesEditor(pi, runtime, ctx);
    },
  });
};

/**
 * Handle a `/cleanup` subcommand.
 *
 * @param action - The cleanup command context.
 * @param trimmed - The trimmed subcommand string.
 * @returns True when a subcommand was handled.
 */
const handleCleanupCommand = async (
  action: CleanupCommandContextValue,
  trimmed: string,
): Promise<boolean> => {
  switch (trimmed) {
    case "on": {
      dispatchCleanupCommand(
        { ctx: action.ctx, event: TransitionEvent.UserEnabled(), runtime: action.runtime },
        "Cleanup enabled.",
      );
      return true;
    }

    case "off": {
      dispatchCleanupCommand(
        { ctx: action.ctx, event: TransitionEvent.UserDisabled(), runtime: action.runtime },
        "Cleanup disabled.",
      );
      return true;
    }

    case "resume": {
      dispatchCleanupCommand(
        { ctx: action.ctx, event: TransitionEvent.UserResumed(), runtime: action.runtime },
        "Cleanup resumed.",
      );
      return true;
    }

    case "reload": {
      await handleCleanupReload(action.pi, action.runtime, action.ctx);
      return true;
    }

    case "collapse": {
      await handleCleanupCollapse(action.runtime, action.ctx);
      return true;
    }

    default: {
      return false;
    }
  }
};

/**
 * Register the /cleanup command.
 *
 * @param pi - The extension API.
 * @param runtime - The runtime state.
 */
export const registerCleanupCommand = (pi: ExtensionAPI, runtime: RuntimeState): void => {
  pi.registerCommand("cleanup", {
    description: "Control cleanup extension (on, off, resume, reload, collapse, status)",
    handler: async (args, ctx) => {
      storeCommandCtx(runtime, ctx);

      if (await handleCleanupCommand({ ctx, pi, runtime }, args.trim())) {
        return;
      }

      handleCleanupStatus(runtime, ctx);
    },
  });
};

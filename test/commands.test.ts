import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Either, Option } from "effect";

vi.mock("../src/types.js", async () => {
  const actual = await vi.importActual<typeof import("../src/types.js")>("../src/types.js");

  return {
    ...actual,
    decodeGateCommand: vi.fn(actual.decodeGateCommand),
  };
});

import { ParseGateInputError, parseGateInput, registerGatesCommand } from "../src/commands.js";
import { ENTRY_TYPE_GATES } from "../src/persistence.js";
import { createInitialRuntimeState } from "../src/runtime.js";
import { CleanupState } from "../src/state-machine.js";
import { AwaitingReason, decodeGateCommand } from "../src/types.js";

const decodeGateCommandMock = vi.mocked(decodeGateCommand);
const defaultDecodeGateCommand = decodeGateCommandMock.getMockImplementation();

if (defaultDecodeGateCommand === undefined) {
  throw new Error("decodeGateCommand mock is missing a default implementation");
}

const makeCtx = () => {
  const editor = vi.fn(async () => undefined);
  const navigateTree = vi.fn(async () => ({ cancelled: false }));
  const notify = vi.fn();
  const setStatus = vi.fn();
  const themeFg = vi.fn((_role: string, text: string) => text);
  const ctx = {
    navigateTree,
    ui: {
      editor,
      notify,
      setStatus,
      theme: { fg: themeFg },
    },
  } as unknown as ExtensionCommandContext;

  return { ctx, editor, navigateTree, notify, setStatus };
};

const makePi = () => {
  const appendEntry = vi.fn();
  const commandHandlers = new Map<string, (args: string, ctx: unknown) => void | Promise<void>>();
  const pi = {
    appendEntry,
    registerCommand: (
      name: string,
      spec: {
        description: string;
        handler: (args: string, ctx: unknown) => void | Promise<void>;
      },
    ) => {
      commandHandlers.set(name, spec.handler);
    },
  } as unknown as ExtensionAPI;

  return { appendEntry, commandHandlers, pi };
};

const getGateConfig = (runtime: ReturnType<typeof createInitialRuntimeState>) => {
  if (Option.isNone(runtime.gateConfig)) {
    throw new Error("expected gate config to be present");
  }

  return runtime.gateConfig.value;
};

const invokeGatesCommand = async (
  args: string,
  runtime = createInitialRuntimeState(),
  options: { readonly editorResult?: string } = {},
) => {
  const { appendEntry, commandHandlers, pi } = makePi();
  const { ctx, editor, notify, setStatus } = makeCtx();

  if ("editorResult" in options) {
    editor.mockResolvedValueOnce(options.editorResult);
  }

  registerGatesCommand(pi, runtime);

  const handler = commandHandlers.get("gates");

  if (handler === undefined) {
    throw new Error("/gates handler was not registered");
  }

  await handler(args, ctx);

  return { appendEntry, editor, notify, runtime, setStatus };
};

beforeEach(() => {
  decodeGateCommandMock.mockClear();
  decodeGateCommandMock.mockImplementation(defaultDecodeGateCommand);
});

describe("parseGateInput", () => {
  it("returns Either.right for a single valid command", () => {
    const result = parseGateInput("npm test");

    expect(result).toStrictEqual(
      Either.right({
        commands: ["npm test"],
        description: "User configured",
      }),
    );
  });

  it("returns Either.right for multiple valid commands", () => {
    const result = parseGateInput("npm test\nnpm run lint\nnpm run build");

    expect(result).toStrictEqual(
      Either.right({
        commands: ["npm test", "npm run lint", "npm run build"],
        description: "User configured",
      }),
    );
  });

  it("returns Either.left(Empty) for empty input", () => {
    const result = parseGateInput("");

    expect(result).toStrictEqual(Either.left(ParseGateInputError.Empty()));
  });

  it("returns Either.left(Empty) for whitespace-only input", () => {
    const result = parseGateInput("   \n  \n  ");

    expect(result).toStrictEqual(Either.left(ParseGateInputError.Empty()));
  });

  it("returns Either.left(InvalidCommand) when the first invalid line trims to empty", () => {
    const result = parseGateInput("npm test\n   \nnpm run lint");

    expect(result).toStrictEqual(Either.left(ParseGateInputError.InvalidCommand({ raw: "" })));
  });

  it("trims whitespace from valid commands", () => {
    const result = parseGateInput("  npm test  \n  npm run lint  ");

    expect(result).toStrictEqual(
      Either.right({
        commands: ["npm test", "npm run lint"],
        description: "User configured",
      }),
    );
  });
});

describe("registerGatesCommand", () => {
  it("configures a single command non-interactively", async () => {
    const { appendEntry, editor, notify, runtime } = await invokeGatesCommand(
      "configure just check",
    );

    expect(editor).not.toHaveBeenCalled();
    expect(getGateConfig(runtime)).toStrictEqual({
      commands: ["just check"],
      description: "User configured",
    });
    expect(appendEntry).toHaveBeenCalledWith(ENTRY_TYPE_GATES, {
      commands: ["just check"],
      description: "User configured",
    });
    expect(notify).toHaveBeenCalledWith("Gates configured: 1 commands.", "info");
  });

  it("configures multiple commands from embedded newlines", async () => {
    const { appendEntry, editor, notify, runtime } = await invokeGatesCommand(
      "configure\njust check\nnpm run lint",
    );

    expect(editor).not.toHaveBeenCalled();
    expect(getGateConfig(runtime)).toStrictEqual({
      commands: ["just check", "npm run lint"],
      description: "User configured",
    });
    expect(appendEntry).toHaveBeenCalledWith(ENTRY_TYPE_GATES, {
      commands: ["just check", "npm run lint"],
      description: "User configured",
    });
    expect(notify).toHaveBeenCalledWith("Gates configured: 2 commands.", "info");
  });

  it("preserves configure behavior by ignoring blank lines between commands", async () => {
    const { appendEntry, runtime } = await invokeGatesCommand(
      "configure just check\n\nnpm run lint",
    );

    expect(getGateConfig(runtime)).toStrictEqual({
      commands: ["just check", "npm run lint"],
      description: "User configured",
    });
    expect(appendEntry).toHaveBeenCalledWith(ENTRY_TYPE_GATES, {
      commands: ["just check", "npm run lint"],
      description: "User configured",
    });
  });

  it("shows a usage hint for configure with empty args", async () => {
    const runtime = createInitialRuntimeState();
    runtime.gateConfig = Option.some({
      commands: ["just check"],
      description: "Existing config",
    } as const);

    const { appendEntry, editor, notify } = await invokeGatesCommand("configure", runtime);

    expect(editor).not.toHaveBeenCalled();
    expect(getGateConfig(runtime)).toStrictEqual({
      commands: ["just check"],
      description: "Existing config",
    });
    expect(appendEntry).not.toHaveBeenCalled();
    expect(notify.mock.calls).toStrictEqual([
      [
        "Usage: /gates configure <command>\nProvide one command per line for multiple gates.",
        "warning",
      ],
    ]);
  });

  it("leaves existing gates unchanged when configure validation fails", async () => {
    const runtime = createInitialRuntimeState();
    runtime.gateConfig = Option.some({
      commands: ["just check"],
      description: "Existing config",
    } as const);
    decodeGateCommandMock.mockImplementation((input) => {
      if (input === "bad gate") {
        return Either.left("invalid" as never);
      }

      return defaultDecodeGateCommand(input);
    });

    const { appendEntry, editor, notify } = await invokeGatesCommand(
      "configure just check\nbad gate",
      runtime,
    );

    expect(editor).not.toHaveBeenCalled();
    expect(getGateConfig(runtime)).toStrictEqual({
      commands: ["just check"],
      description: "Existing config",
    });
    expect(appendEntry).not.toHaveBeenCalled();
    expect(notify.mock.calls).toStrictEqual([[`Invalid gate command: "bad gate"`, "error"]]);
  });

  it("notifies when the editor input is empty", async () => {
    const runtime = createInitialRuntimeState();
    runtime.gateConfig = Option.some({
      commands: ["just check"],
      description: "Existing config",
    } as const);

    const { appendEntry, notify } = await invokeGatesCommand("", runtime, { editorResult: "" });

    expect(getGateConfig(runtime)).toStrictEqual({
      commands: ["just check"],
      description: "Existing config",
    });
    expect(appendEntry).not.toHaveBeenCalled();
    expect(notify.mock.calls).toStrictEqual([["No commands entered. Gates not changed.", "warning"]]);
  });

  it("notifies when editor input contains an invalid command", async () => {
    decodeGateCommandMock.mockImplementation((input) => {
      if (input === "bad gate") {
        return Either.left("invalid" as never);
      }

      return defaultDecodeGateCommand(input);
    });

    const { appendEntry, notify, runtime } = await invokeGatesCommand("", createInitialRuntimeState(), {
      editorResult: "just check\nbad gate",
    });

    expect(Option.isNone(runtime.gateConfig)).toStrictEqual(true);
    expect(appendEntry).not.toHaveBeenCalled();
    expect(notify.mock.calls).toStrictEqual([[`Invalid gate command: "bad gate"`, "error"]]);
  });

  it("transitions AwaitingUserInput to Idle after successful configure", async () => {
    const runtime = createInitialRuntimeState();
    runtime.cleanup = CleanupState.AwaitingUserInput({
      reason: AwaitingReason.GatesUnconfigured(),
    });

    const { runtime: updatedRuntime, setStatus } = await invokeGatesCommand(
      "configure just check",
      runtime,
    );

    expect(updatedRuntime.cleanup._tag).toStrictEqual("Idle");
    expect(setStatus).toHaveBeenCalledWith("cleanup", undefined);
  });
});

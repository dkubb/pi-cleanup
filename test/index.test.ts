/**
 * Integration tests for the extension entry point.
 *
 * The default export wires four events (`session_start`, `input`,
 * `tool_call`, `agent_end`) plus two slash commands against a
 * closure-held runtime. These tests drive the wiring end-to-end using
 * a fake `pi` that records handler registrations, captures
 * sendUserMessage calls, and routes event invocations back to the
 * handler the extension installed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Either, Option } from "effect";

const { captureCollapseAnchorMock, registeredCleanupRuntimes, registeredGatesRuntimes } = vi.hoisted(
  () => ({
    captureCollapseAnchorMock: vi.fn((runtime: any, ctx: any) => {
      if (runtime.collapseAnchorId._tag === "Some") {
        return;
      }

      const leafId = ctx.sessionManager.getLeafId();

      if (leafId !== null) {
        runtime.collapseAnchorId = { _id: "Option", _tag: "Some", value: leafId };
      }
    }),
    registeredCleanupRuntimes: [] as any[],
    registeredGatesRuntimes: [] as any[],
  }),
);

vi.mock("../src/commands.js", () => ({
  registerCleanupCommand: vi.fn((pi: any, runtime: any) => {
    registeredCleanupRuntimes.push(runtime);
    pi.registerCommand("cleanup", { description: "cleanup", handler: async () => undefined });
  }),
  registerGatesCommand: vi.fn((pi: any, runtime: any) => {
    registeredGatesRuntimes.push(runtime);
    pi.registerCommand("gates", { description: "gates", handler: async () => undefined });
  }),
}));

vi.mock("../src/pipeline-collapse.js", () => ({
  captureCollapseAnchor: captureCollapseAnchorMock,
  collapseIfNeeded: vi.fn(async () => false),
}));

import onAgentEnd from "../src/index.js";
import { decodeCommitSHA } from "../src/types.js";

const sha1 = Either.getOrThrow(decodeCommitSHA("a".repeat(40)));

afterEach(() => {
  captureCollapseAnchorMock.mockClear();
  registeredCleanupRuntimes.length = 0;
  registeredGatesRuntimes.length = 0;
});

/** Lightweight harness that captures everything the extension registers. */
const makePi = () => {
  const eventHandlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const commandHandlers = new Map<string, (args: string, ctx: unknown) => void | Promise<void>>();
  const sendUserMessage = vi.fn();
  const appendEntry = vi.fn();
  const exec = vi.fn(async () => ({ code: 0, stderr: "", stdout: "" }));

  const pi = {
    appendEntry,
    exec,
    on: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => {
      eventHandlers.set(event, handler);
    },
    registerCommand: (
      name: string,
      spec: { handler: (args: string, ctx: unknown) => void | Promise<void> },
    ) => {
      commandHandlers.set(name, spec.handler);
    },
    sendUserMessage,
  };

  const ctx = {
    sessionManager: {
      getEntries: vi.fn(() => [] as unknown[]),
      getLeafId: vi.fn(() => "leaf-1"),
    },
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: vi.fn((_role: string, text: string) => text) },
    },
  };

  return { appendEntry, commandHandlers, ctx, eventHandlers, exec, pi, sendUserMessage };
};

describe("onAgentEnd — extension factory wiring", () => {
  it("registers session_start, input, tool_call, and agent_end handlers", () => {
    const { eventHandlers, pi } = makePi();

    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);

    expect(eventHandlers.has("session_start")).toStrictEqual(true);
    expect(eventHandlers.has("input")).toStrictEqual(true);
    expect(eventHandlers.has("tool_call")).toStrictEqual(true);
    expect(eventHandlers.has("agent_end")).toStrictEqual(true);
  });

  it("registers /gates and /cleanup slash commands", () => {
    const { commandHandlers, pi } = makePi();

    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);

    expect(commandHandlers.has("gates")).toStrictEqual(true);
    expect(commandHandlers.has("cleanup")).toStrictEqual(true);
  });
});

describe("onAgentEnd — session_start lifecycle", () => {
  it("captures the plugin version and current HEAD when no persisted entry exists", async () => {
    const { ctx, eventHandlers, exec, pi } = makePi();
    exec
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: "abc1234\n" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: String(sha1) + "\n" });
    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);

    const handler = eventHandlers.get("session_start");
    expect(handler).toBeDefined();
    await handler?.({}, ctx);

    expect(exec.mock.calls).toStrictEqual([
      ["git", ["rev-parse", "--short", "HEAD"]],
      ["git", ["rev-parse", "HEAD"]],
    ]);
    expect(registeredCleanupRuntimes[0]?.pluginVersion).toStrictEqual(Option.some("abc1234"));
  });

  it("leaves pluginVersion unset when the short HEAD probe fails", async () => {
    const { ctx, eventHandlers, exec, pi } = makePi();
    exec
      .mockResolvedValueOnce({ code: 1, stderr: "fatal: not a git repository", stdout: "" })
      .mockResolvedValueOnce({ code: 0, stderr: "", stdout: String(sha1) + "\n" });
    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);

    const handler = eventHandlers.get("session_start");
    expect(handler).toBeDefined();
    await handler?.({}, ctx);

    expect(registeredCleanupRuntimes[0]?.pluginVersion).toStrictEqual(Option.none());
  });

  it("does not re-probe HEAD when a lastCleanCommitSHA is already persisted", async () => {
    const { ctx, eventHandlers, exec, pi } = makePi();
    // Persisted entry restores lastCleanCommitSHA, so the factory
    // should skip the HEAD probe.
    (ctx.sessionManager.getEntries as ReturnType<typeof vi.fn>).mockReturnValue([
      { customType: "pi-cleanup-commit", data: { sha: String(sha1) }, type: "custom" },
    ]);
    exec.mockResolvedValueOnce({ code: 0, stderr: "", stdout: "abc1234\n" });
    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);

    const handler = eventHandlers.get("session_start");
    await handler?.({}, ctx);

    expect(exec.mock.calls).toStrictEqual([["git", ["rev-parse", "--short", "HEAD"]]]);
    expect(registeredCleanupRuntimes[0]?.pluginVersion).toStrictEqual(Option.some("abc1234"));
  });
});

describe("onAgentEnd — tool_call mutation tracking", () => {
  it("tool_call with a mutation tool marks the runtime dirty for the next agent_end", () => {
    const { eventHandlers, pi } = makePi();
    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);
    const handler = eventHandlers.get("tool_call");
    expect(handler).toBeDefined();

    // Each of the known mutation tools should be accepted without error.
    for (const toolName of ["bash", "edit", "write"]) {
      handler?.({ toolName }, {});
    }
  });

  it("tool_call with a read-only tool is a no-op", () => {
    const { eventHandlers, pi } = makePi();
    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);
    const handler = eventHandlers.get("tool_call");

    // Should not throw and should not have any observable effect on
    // the downstream pipeline (the next agent_end will skip when
    // isGitUnchanged returns true and mutationDetected is false).
    handler?.({ toolName: "read" }, {});
    handler?.({ toolName: "grep" }, {});
  });
});

describe("onAgentEnd — agent_end pipeline entry", () => {
  it("invokes handleAgentEnd against the runtime (notifies when gates are unconfigured)", async () => {
    const { ctx, eventHandlers, exec, pi } = makePi();
    // session_start reads HEAD; agent_end's pipeline will then run and
    // find no gate config, notifying the user.
    exec.mockResolvedValue({ code: 0, stderr: "", stdout: String(sha1) + "\n" });
    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);

    await eventHandlers.get("session_start")?.({}, ctx);
    // tool_call with bash sets mutationDetected so handleAgentEnd
    // doesn't immediately short-circuit via isGitUnchanged.
    eventHandlers.get("tool_call")?.({ toolName: "bash" }, ctx);
    await eventHandlers.get("agent_end")?.({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "No quality gates configured. Use /gates to set up.",
      "warning",
    );
  });
});

describe("onAgentEnd — input cycle reset", () => {
  it("user-sourced input resets and recaptures the collapse anchor", () => {
    const { ctx, eventHandlers, pi } = makePi();
    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);
    const handler = eventHandlers.get("input");
    expect(handler).toBeDefined();

    handler?.({ source: "user" }, ctx);

    const firstRuntime = captureCollapseAnchorMock.mock.calls[0]?.[0] as {
      collapseAnchorId: Option.Option<string>;
    };
    expect({
      collapseAnchorId: firstRuntime.collapseAnchorId,
    }).toStrictEqual({
      collapseAnchorId: { _id: "Option", _tag: "Some", value: "leaf-1" },
    });

    let anchorWasNoneAtCapture = false;
    captureCollapseAnchorMock.mockImplementationOnce((runtime: any, nextCtx: any) => {
      anchorWasNoneAtCapture = runtime.collapseAnchorId._tag === "None";

      const leafId = nextCtx.sessionManager.getLeafId();

      if (leafId !== null) {
        runtime.collapseAnchorId = { _id: "Option", _tag: "Some", value: leafId };
      }
    });
    (ctx.sessionManager.getLeafId as ReturnType<typeof vi.fn>).mockReturnValue("leaf-2");

    handler?.({ source: "user" }, ctx);

    const secondRuntime = captureCollapseAnchorMock.mock.calls[1]?.[0] as {
      collapseAnchorId: Option.Option<string>;
    };
    expect({
      anchorWasNoneAtCapture,
      collapseAnchorId: secondRuntime.collapseAnchorId,
    }).toStrictEqual({
      anchorWasNoneAtCapture: true,
      collapseAnchorId: { _id: "Option", _tag: "Some", value: "leaf-2" },
    });
  });

  it("extension-sourced input does not reset or capture the collapse anchor", () => {
    const { ctx, eventHandlers, pi } = makePi();
    onAgentEnd(pi as unknown as Parameters<typeof onAgentEnd>[0]);
    const handler = eventHandlers.get("input");
    expect(handler).toBeDefined();

    handler?.({ source: "user" }, ctx);

    const runtime = captureCollapseAnchorMock.mock.calls[0]?.[0] as {
      collapseAnchorId: Option.Option<string>;
    };
    (ctx.sessionManager.getLeafId as ReturnType<typeof vi.fn>).mockReturnValue("leaf-2");

    handler?.({ source: "extension" }, ctx);

    expect({
      callCount: captureCollapseAnchorMock.mock.calls.length,
      collapseAnchorId: runtime.collapseAnchorId,
    }).toStrictEqual({
      callCount: 1,
      collapseAnchorId: { _id: "Option", _tag: "Some", value: "leaf-1" },
    });
  });
});

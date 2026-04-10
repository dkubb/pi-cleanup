import { describe, expect, it, vi } from "vitest";
import { Option } from "effect";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
  captureCollapseAnchor,
  collapseIfNeeded,
  formatCycleActions,
} from "../src/pipeline-phases.js";
import { createInitialRuntimeState } from "../src/runtime.js";

// ---------------------------------------------------------------------------
// formatCycleActions
// ---------------------------------------------------------------------------

describe("formatCycleActions", () => {
  it("formats actions as bullet list", () => {
    const result = formatCycleActions(["Fixed gate", "Committed changes"]);
    expect(result).toStrictEqual("- Fixed gate\n- Committed changes");
  });

  it("returns default message for empty actions", () => {
    const result = formatCycleActions([]);
    expect(result).toStrictEqual(
      "- No fixes needed (all checks passed on first evaluation)",
    );
  });

  it("formats a single action", () => {
    const result = formatCycleActions(["Verified task completion"]);
    expect(result).toStrictEqual("- Verified task completion");
  });
});

// ---------------------------------------------------------------------------
// captureCollapseAnchor
// ---------------------------------------------------------------------------

const makeCtx = (leafId: string | null = "entry-123") => {
  const ctx = {
    sessionManager: { getLeafId: vi.fn(() => leafId) },
  } as unknown as ExtensionContext;

  return ctx;
};

describe("captureCollapseAnchor", () => {
  it("captures leaf ID when no anchor exists", () => {
    const runtime = createInitialRuntimeState();
    const ctx = makeCtx("entry-abc");
    captureCollapseAnchor(runtime, ctx);

    expect(Option.isSome(runtime.collapseAnchorId)).toStrictEqual(true);
    const value = (runtime.collapseAnchorId as Option.Some<string>).value;
    expect(value).toStrictEqual("entry-abc");
  });

  it("does not overwrite existing anchor", () => {
    const runtime = createInitialRuntimeState();
    runtime.collapseAnchorId = Option.some("first-anchor");
    const ctx = makeCtx("entry-xyz");
    captureCollapseAnchor(runtime, ctx);

    const value = (runtime.collapseAnchorId as Option.Some<string>).value;
    expect(value).toStrictEqual("first-anchor");
  });

  it("does not set anchor when leaf ID is null", () => {
    const runtime = createInitialRuntimeState();
    const ctx = makeCtx(null);
    captureCollapseAnchor(runtime, ctx);

    expect(Option.isNone(runtime.collapseAnchorId)).toStrictEqual(true);
  });
});

// ---------------------------------------------------------------------------
// collapseIfNeeded
// ---------------------------------------------------------------------------

describe("collapseIfNeeded", () => {
  it("returns false when no anchor is set", async () => {
    const runtime = createInitialRuntimeState();
    runtime.commandCtx = Option.some({
      navigateTree: vi.fn(async () => ({ cancelled: false })),
    });
    const result = await collapseIfNeeded(runtime);
    expect(result).toStrictEqual(false);
  });

  it("returns false when no command context is set", async () => {
    const runtime = createInitialRuntimeState();
    runtime.collapseAnchorId = Option.some("anchor-123");
    const result = await collapseIfNeeded(runtime);
    expect(result).toStrictEqual(false);
  });

  it("calls navigateTree with anchor ID and summarize option", async () => {
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    const runtime = createInitialRuntimeState();
    runtime.collapseAnchorId = Option.some("anchor-456");
    runtime.commandCtx = Option.some({ navigateTree });
    runtime.cycleActions = ["Fixed gate"];

    const result = await collapseIfNeeded(runtime);

    expect(result).toStrictEqual(true);
    expect(navigateTree).toHaveBeenCalledWith("anchor-456", {
      customInstructions: "Cleanup cycle summary:\n- Fixed gate",
      summarize: true,
    });
  });

  it("clears anchor after collapse", async () => {
    const navigateTree = vi.fn(async () => ({ cancelled: false }));
    const runtime = createInitialRuntimeState();
    runtime.collapseAnchorId = Option.some("anchor-789");
    runtime.commandCtx = Option.some({ navigateTree });

    await collapseIfNeeded(runtime);

    expect(Option.isNone(runtime.collapseAnchorId)).toStrictEqual(true);
  });
});

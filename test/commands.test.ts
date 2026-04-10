import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { parseGateInput } from "../src/commands.js";

const makeCtx = () => {
  const notify = vi.fn();
  const ctx = { ui: { notify } } as unknown as ExtensionCommandContext;

  return { ctx, notify };
};

describe("parseGateInput", () => {
  it("returns undefined for empty input", () => {
    const { ctx, notify } = makeCtx();
    const result = parseGateInput("", ctx);

    expect(result).toStrictEqual(undefined);
    expect(notify).toHaveBeenCalledWith("No commands entered. Gates not changed.", "warning");
  });

  it("returns undefined for whitespace-only input", () => {
    const { ctx } = makeCtx();
    const result = parseGateInput("   \n  \n  ", ctx);

    expect(result).toStrictEqual(undefined);
  });

  it("parses a single command", () => {
    const { ctx } = makeCtx();
    const result = parseGateInput("npm test", ctx);

    expect(result).toStrictEqual({
      commands: ["npm test"],
      description: "User configured",
    });
  });

  it("parses multiple commands from newlines", () => {
    const { ctx } = makeCtx();
    const result = parseGateInput("npm test\nnpm run lint\nnpm run build", ctx);

    expect(result).toStrictEqual({
      commands: ["npm test", "npm run lint", "npm run build"],
      description: "User configured",
    });
  });

  it("filters out blank lines between commands", () => {
    const { ctx } = makeCtx();
    const result = parseGateInput("npm test\n\n\nnpm run lint", ctx);

    expect(result).toStrictEqual({
      commands: ["npm test", "npm run lint"],
      description: "User configured",
    });
  });

  it("trims whitespace from commands", () => {
    const { ctx } = makeCtx();
    const result = parseGateInput("  npm test  \n  npm run lint  ", ctx);

    expect(result).toStrictEqual({
      commands: ["npm test", "npm run lint"],
      description: "User configured",
    });
  });

  it("returns undefined and notifies for invalid command", () => {
    const { ctx, notify } = makeCtx();
    const result = parseGateInput("npm test\n   \nnpm run lint", ctx);

    // The blank line is filtered out, so this should succeed
    expect(result).toStrictEqual({
      commands: ["npm test", "npm run lint"],
      description: "User configured",
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { warn } from "../src/logger.js";

describe("warn", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the exact pi-cleanup payload to console.warn", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warn("ctx", "msg");

    expect(consoleWarn.mock.calls).toStrictEqual([["[pi-cleanup] ctx: msg"]]);
  });

  it("supports an empty context", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warn("", "msg");

    expect(consoleWarn.mock.calls).toStrictEqual([["[pi-cleanup] : msg"]]);
  });

  it("supports an empty message", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warn("ctx", "");

    expect(consoleWarn.mock.calls).toStrictEqual([["[pi-cleanup] ctx: "]]);
  });
});

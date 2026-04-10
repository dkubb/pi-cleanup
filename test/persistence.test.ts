import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  ENTRY_TYPE_COMMIT,
  ENTRY_TYPE_GATES,
  persistCleanCommit,
  persistGateConfig,
  persistGatesClear,
} from "../src/persistence.js";
import type { AppendEntryFn, CommitSHA, GateConfig } from "../src/types.js";
import { decodeCommitSHA, decodeGateCommand } from "../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type AppendCall = { type: string; data: unknown };

const makeAppend = (): { fn: AppendEntryFn; calls: AppendCall[] } => {
  const calls: AppendCall[] = [];
  const fn: AppendEntryFn = (type: string, data?: unknown) => {
    calls.push({ type, data });
  };
  return { fn, calls };
};

const sha = (c: string): CommitSHA =>
  Either.getOrThrow(decodeCommitSHA(c.repeat(40).slice(0, 40)));

const sha1 = sha("a");
const sha2 = sha("f");

const cmd = (s: string) => Either.getOrThrow(decodeGateCommand(s));

const singleCmdConfig: GateConfig = {
  commands: [cmd("npm test")],
  description: "Run tests",
};

const multiCmdConfig: GateConfig = {
  commands: [cmd("npm test"), cmd("npm run lint"), cmd("npm run build")],
  description: "Full CI pipeline",
};

// ---------------------------------------------------------------------------
// ENTRY_TYPE constants
// ---------------------------------------------------------------------------

describe("entry type constants", () => {
  it("ENTRY_TYPE_GATES is the correct string", () => {
    expect(ENTRY_TYPE_GATES).toStrictEqual("pi-cleanup-gates");
  });

  it("ENTRY_TYPE_COMMIT is the correct string", () => {
    expect(ENTRY_TYPE_COMMIT).toStrictEqual("pi-cleanup-commit");
  });
});

// ---------------------------------------------------------------------------
// persistGateConfig
// ---------------------------------------------------------------------------

describe("persistGateConfig", () => {
  it("calls appendEntry exactly once", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, singleCmdConfig);
    expect(calls).toHaveLength(1);
  });

  it("uses ENTRY_TYPE_GATES as the custom type", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, singleCmdConfig);
    expect(calls[0]!.type).toStrictEqual(ENTRY_TYPE_GATES);
  });

  it("serializes commands as plain strings", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, singleCmdConfig);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(data["commands"]).toEqual(["npm test"]);
  });

  it("serializes multiple commands as array of strings", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, multiCmdConfig);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(data["commands"]).toEqual(["npm test", "npm run lint", "npm run build"]);
  });

  it("preserves description", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, singleCmdConfig);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(data["description"]).toStrictEqual("Run tests");
  });

  it("preserves description from multi-command config", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, multiCmdConfig);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(data["description"]).toStrictEqual("Full CI pipeline");
  });

  it("does not include a cleared field", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, singleCmdConfig);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(data["cleared"]).toBeUndefined();
  });

  it("data does not contain branded type objects", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, singleCmdConfig);
    const data = calls[0]!.data as Record<string, unknown>;
    const commands = data["commands"] as unknown[];
    // Each command should be a plain string, not an object
    for (const c of commands) {
      expect(typeof c).toStrictEqual("string");
    }
  });
});

// ---------------------------------------------------------------------------
// persistGatesClear
// ---------------------------------------------------------------------------

describe("persistGatesClear", () => {
  it("calls appendEntry exactly once", () => {
    const { fn, calls } = makeAppend();
    persistGatesClear(fn);
    expect(calls).toHaveLength(1);
  });

  it("uses ENTRY_TYPE_GATES as the custom type", () => {
    const { fn, calls } = makeAppend();
    persistGatesClear(fn);
    expect(calls[0]!.type).toStrictEqual(ENTRY_TYPE_GATES);
  });

  it("sets cleared to true", () => {
    const { fn, calls } = makeAppend();
    persistGatesClear(fn);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(data["cleared"]).toStrictEqual(true);
  });

  it("does not include a commands field", () => {
    const { fn, calls } = makeAppend();
    persistGatesClear(fn);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(data["commands"]).toBeUndefined();
  });

  it("does not include a description field", () => {
    const { fn, calls } = makeAppend();
    persistGatesClear(fn);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(data["description"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// persistCleanCommit
// ---------------------------------------------------------------------------

describe("persistCleanCommit", () => {
  it("calls appendEntry exactly once", () => {
    const { fn, calls } = makeAppend();
    persistCleanCommit(fn, sha1);
    expect(calls).toHaveLength(1);
  });

  it("uses ENTRY_TYPE_COMMIT as the custom type", () => {
    const { fn, calls } = makeAppend();
    persistCleanCommit(fn, sha1);
    expect(calls[0]!.type).toStrictEqual(ENTRY_TYPE_COMMIT);
  });

  it("serializes SHA as a plain string in sha field", () => {
    const { fn, calls } = makeAppend();
    persistCleanCommit(fn, sha1);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(typeof data["sha"]).toStrictEqual("string");
    expect(data["sha"]).toStrictEqual("a".repeat(40));
  });

  it("serializes different SHAs correctly", () => {
    const { fn, calls } = makeAppend();
    persistCleanCommit(fn, sha2);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(data["sha"]).toStrictEqual("f".repeat(40));
  });

  it("data contains only the sha field", () => {
    const { fn, calls } = makeAppend();
    persistCleanCommit(fn, sha1);
    const data = calls[0]!.data as Record<string, unknown>;
    expect(Object.keys(data)).toEqual(["sha"]);
  });
});

// ---------------------------------------------------------------------------
// Multiple calls independence
// ---------------------------------------------------------------------------

describe("multiple persistence calls are independent", () => {
  it("two persistGateConfig calls produce two entries", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, singleCmdConfig);
    persistGateConfig(fn, multiCmdConfig);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.type).toStrictEqual(ENTRY_TYPE_GATES);
    expect(calls[1]!.type).toStrictEqual(ENTRY_TYPE_GATES);
  });

  it("mixed persistence calls each produce one entry", () => {
    const { fn, calls } = makeAppend();
    persistGateConfig(fn, singleCmdConfig);
    persistGatesClear(fn);
    persistCleanCommit(fn, sha1);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.type).toStrictEqual(ENTRY_TYPE_GATES);
    expect(calls[1]!.type).toStrictEqual(ENTRY_TYPE_GATES);
    expect(calls[2]!.type).toStrictEqual(ENTRY_TYPE_COMMIT);
  });
});

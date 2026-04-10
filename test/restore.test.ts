import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { restoreCommitSHA, restoreGateConfig } from "../src/restore.js";

// ---------------------------------------------------------------------------
// restoreGateConfig
// ---------------------------------------------------------------------------

describe("restoreGateConfig — valid config", () => {
  it("restores a single-command config", () => {
    const data = { commands: ["npm test"], description: "Run tests" };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.commands).toHaveLength(1);
      expect(result.value.commands[0]).toBe("npm test");
      expect(result.value.description).toBe("Run tests");
    }
  });

  it("restores a multi-command config", () => {
    const data = {
      commands: ["npm test", "npm run lint", "npm run build"],
      description: "Full CI",
    };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.commands).toHaveLength(3);
      expect(result.value.commands[0]).toBe("npm test");
      expect(result.value.commands[1]).toBe("npm run lint");
      expect(result.value.commands[2]).toBe("npm run build");
    }
  });

  it("uses default description when description is missing", () => {
    const data = { commands: ["npm test"] };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.description).toBe("Restored from session");
    }
  });

  it("uses default description when description is not a string", () => {
    const data = { commands: ["npm test"], description: 42 };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.description).toBe("Restored from session");
    }
  });

  it("uses default description when description is null", () => {
    const data = { commands: ["npm test"], description: null };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.description).toBe("Restored from session");
    }
  });

  it("filters out invalid commands from the array", () => {
    const data = { commands: ["npm test", "", "  ", "npm run lint"], description: "test" };
    const result = restoreGateConfig(data);
    // Only valid non-empty trimmed commands should be kept
    if (Option.isSome(result)) {
      expect(result.value.commands).toContain("npm test");
      expect(result.value.commands).toContain("npm run lint");
    }
  });

  it("returns None when all commands are invalid and array is empty after filtering", () => {
    const data = { commands: ["", "  "], description: "test" };
    const result = restoreGateConfig(data);
    expect(Option.isNone(result)).toBe(true);
  });
});

describe("restoreGateConfig — tombstone (cleared)", () => {
  it("returns None for cleared tombstone", () => {
    const data = { cleared: true };
    const result = restoreGateConfig(data);
    expect(Option.isNone(result)).toBe(true);
  });

  it("returns None for cleared tombstone even if commands present", () => {
    const data = { cleared: true, commands: ["npm test"] };
    const result = restoreGateConfig(data);
    expect(Option.isNone(result)).toBe(true);
  });

  it("does not treat cleared=false as a tombstone", () => {
    const data = { cleared: false, commands: ["npm test"], description: "test" };
    const result = restoreGateConfig(data);
    // cleared=false should not trigger tombstone path
    expect(Option.isSome(result)).toBe(true);
  });
});

describe("restoreGateConfig — invalid / edge-case data", () => {
  it("returns None for null data", () => {
    expect(Option.isNone(restoreGateConfig(null))).toBe(true);
  });

  it("returns None for undefined data", () => {
    expect(Option.isNone(restoreGateConfig(undefined))).toBe(true);
  });

  it("returns None for empty object", () => {
    expect(Option.isNone(restoreGateConfig({}))).toBe(true);
  });

  it("returns None when commands is not an array", () => {
    expect(Option.isNone(restoreGateConfig({ commands: "npm test" }))).toBe(true);
  });

  it("returns None when commands is null", () => {
    expect(Option.isNone(restoreGateConfig({ commands: null }))).toBe(true);
  });

  it("returns None when commands is a number", () => {
    expect(Option.isNone(restoreGateConfig({ commands: 42 }))).toBe(true);
  });

  it("returns None for a plain string", () => {
    expect(Option.isNone(restoreGateConfig("npm test"))).toBe(true);
  });

  it("returns None for a number", () => {
    expect(Option.isNone(restoreGateConfig(42))).toBe(true);
  });

  it("returns None for an array", () => {
    expect(Option.isNone(restoreGateConfig(["npm test"]))).toBe(true);
  });

  it("returns None for an empty commands array", () => {
    expect(Option.isNone(restoreGateConfig({ commands: [] }))).toBe(true);
  });

  it("returns None when commands array contains only non-strings", () => {
    expect(Option.isNone(restoreGateConfig({ commands: [42, null, true] }))).toBe(true);
  });

  it("skips non-string values in commands array", () => {
    const data = { commands: [42, "npm test", null, "npm run lint"], description: "test" };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.commands).toContain("npm test");
      expect(result.value.commands).toContain("npm run lint");
    }
  });
});

// ---------------------------------------------------------------------------
// restoreCommitSHA
// ---------------------------------------------------------------------------

describe("restoreCommitSHA — valid data", () => {
  it("restores a valid 40-char lowercase hex SHA", () => {
    const sha = "a".repeat(40);
    const result = restoreCommitSHA({ sha });
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(String(result.value)).toBe(sha);
    }
  });

  it("restores a different valid SHA", () => {
    const sha = "deadbeef".repeat(5);
    const result = restoreCommitSHA({ sha });
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(String(result.value)).toBe(sha);
    }
  });

  it("restores SHA with mixed valid hex digits 0-9 and a-f", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const result = restoreCommitSHA({ sha });
    expect(Option.isSome(result)).toBe(true);
  });
});

describe("restoreCommitSHA — invalid data", () => {
  it("returns None for null data", () => {
    expect(Option.isNone(restoreCommitSHA(null))).toBe(true);
  });

  it("returns None for undefined data", () => {
    expect(Option.isNone(restoreCommitSHA(undefined))).toBe(true);
  });

  it("returns None for empty object", () => {
    expect(Option.isNone(restoreCommitSHA({}))).toBe(true);
  });

  it("returns None when sha is not a string", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: 42 }))).toBe(true);
  });

  it("returns None when sha is null", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: null }))).toBe(true);
  });

  it("returns None for SHA that is too short", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "abcdef" }))).toBe(true);
  });

  it("returns None for SHA that is too long (41 chars)", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "a".repeat(41) }))).toBe(true);
  });

  it("returns None for SHA with uppercase hex", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "A".repeat(40) }))).toBe(true);
  });

  it("returns None for SHA with non-hex characters", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "g".repeat(40) }))).toBe(true);
  });

  it("returns None for empty string SHA", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "" }))).toBe(true);
  });

  it("returns None for a plain string (not an object)", () => {
    expect(Option.isNone(restoreCommitSHA("a".repeat(40)))).toBe(true);
  });

  it("returns None for a number", () => {
    expect(Option.isNone(restoreCommitSHA(42))).toBe(true);
  });

  it("returns None for an array", () => {
    expect(Option.isNone(restoreCommitSHA(["a".repeat(40)]))).toBe(true);
  });

  it("returns None for SHA with spaces", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: " " + "a".repeat(39) }))).toBe(true);
  });
});

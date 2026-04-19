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
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value.commands).toStrictEqual(["npm test"]);
    expect(value.description).toStrictEqual("Run tests");
  });

  it("restores a multi-command config", () => {
    const data = {
      commands: ["npm test", "npm run lint", "npm run build"],
      description: "Full CI",
    };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value.commands).toStrictEqual(["npm test", "npm run lint", "npm run build"]);
    expect(value.description).toStrictEqual("Full CI");
  });

  it("uses default description when description is missing", () => {
    const data = { commands: ["npm test"] };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value.description).toStrictEqual("Restored from session");
  });

  it("uses default description when description is not a string", () => {
    const data = { commands: ["npm test"], description: 42 };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value.description).toStrictEqual("Restored from session");
  });

  it("uses default description when description is null", () => {
    const data = { commands: ["npm test"], description: null };
    const result = restoreGateConfig(data);
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value.description).toStrictEqual("Restored from session");
  });

  it("returns None when any command in the array is invalid (fail closed)", () => {
    const data = { commands: ["npm test", "", "  ", "npm run lint"], description: "test" };
    const result = restoreGateConfig(data);
    expect(Option.isNone(result)).toStrictEqual(true);
  });

  it("returns None when a single invalid command appears among valid ones", () => {
    const data = { commands: ["npm test", "npm run lint", ""], description: "test" };
    const result = restoreGateConfig(data);
    expect(Option.isNone(result)).toStrictEqual(true);
  });

  it("returns None when all commands are invalid", () => {
    const data = { commands: ["", "  "], description: "test" };
    const result = restoreGateConfig(data);
    expect(Option.isNone(result)).toStrictEqual(true);
  });
});

describe("restoreGateConfig — tombstone (cleared)", () => {
  it("returns None for cleared tombstone", () => {
    const data = { cleared: true };
    const result = restoreGateConfig(data);
    expect(Option.isNone(result)).toStrictEqual(true);
  });

  it("returns None for cleared tombstone even if commands present", () => {
    const data = { cleared: true, commands: ["npm test"] };
    const result = restoreGateConfig(data);
    expect(Option.isNone(result)).toStrictEqual(true);
  });

  it("does not treat cleared=false as a tombstone", () => {
    const data = { cleared: false, commands: ["npm test"], description: "test" };
    const result = restoreGateConfig(data);
    // cleared=false should not trigger tombstone path
    expect(Option.isSome(result)).toStrictEqual(true);
  });
});

describe("restoreGateConfig — invalid / edge-case data", () => {
  it("returns None for null data", () => {
    expect(Option.isNone(restoreGateConfig(null))).toStrictEqual(true);
  });

  it("returns None for undefined data", () => {
    expect(Option.isNone(restoreGateConfig(undefined))).toStrictEqual(true);
  });

  it("returns None for empty object", () => {
    expect(Option.isNone(restoreGateConfig({}))).toStrictEqual(true);
  });

  it("returns None when commands is not an array", () => {
    expect(Option.isNone(restoreGateConfig({ commands: "npm test" }))).toStrictEqual(true);
  });

  it("returns None when commands is null", () => {
    expect(Option.isNone(restoreGateConfig({ commands: null }))).toStrictEqual(true);
  });

  it("returns None when commands is a number", () => {
    expect(Option.isNone(restoreGateConfig({ commands: 42 }))).toStrictEqual(true);
  });

  it("returns None for a plain string", () => {
    expect(Option.isNone(restoreGateConfig("npm test"))).toStrictEqual(true);
  });

  it("returns None for a number", () => {
    expect(Option.isNone(restoreGateConfig(42))).toStrictEqual(true);
  });

  it("returns None for an array", () => {
    expect(Option.isNone(restoreGateConfig(["npm test"]))).toStrictEqual(true);
  });

  it("returns None for an empty commands array", () => {
    expect(Option.isNone(restoreGateConfig({ commands: [] }))).toStrictEqual(true);
  });

  it("returns None when commands array contains only non-strings", () => {
    expect(Option.isNone(restoreGateConfig({ commands: [42, null, true] }))).toStrictEqual(true);
  });

  it("returns None when commands array contains non-string values alongside strings", () => {
    const data = { commands: [42, "npm test", null, "npm run lint"], description: "test" };
    const result = restoreGateConfig(data);
    expect(Option.isNone(result)).toStrictEqual(true);
  });
});

// ---------------------------------------------------------------------------
// restoreCommitSHA
// ---------------------------------------------------------------------------

describe("restoreCommitSHA — valid data", () => {
  it("restores a valid 40-char lowercase hex SHA", () => {
    const sha = "a".repeat(40);
    const result = restoreCommitSHA({ sha });
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(String(value)).toStrictEqual(sha);
  });

  it("restores a different valid SHA", () => {
    const sha = "deadbeef".repeat(5);
    const result = restoreCommitSHA({ sha });
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(String(value)).toStrictEqual(sha);
  });

  it("restores SHA with mixed valid hex digits 0-9 and a-f", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const result = restoreCommitSHA({ sha });
    expect(Option.isSome(result)).toStrictEqual(true);
  });
});

describe("restoreCommitSHA — invalid data", () => {
  it("returns None for null data", () => {
    expect(Option.isNone(restoreCommitSHA(null))).toStrictEqual(true);
  });

  it("returns None for undefined data", () => {
    expect(Option.isNone(restoreCommitSHA(undefined))).toStrictEqual(true);
  });

  it("returns None for empty object", () => {
    expect(Option.isNone(restoreCommitSHA({}))).toStrictEqual(true);
  });

  it("returns None when sha is not a string", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: 42 }))).toStrictEqual(true);
  });

  it("returns None when sha is null", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: null }))).toStrictEqual(true);
  });

  it("returns None for SHA that is too short", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "abcdef" }))).toStrictEqual(true);
  });

  it("returns None for SHA that is too long (41 chars)", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "a".repeat(41) }))).toStrictEqual(true);
  });

  it("returns None for SHA with uppercase hex", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "A".repeat(40) }))).toStrictEqual(true);
  });

  it("returns None for SHA with non-hex characters", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "g".repeat(40) }))).toStrictEqual(true);
  });

  it("returns None for empty string SHA", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: "" }))).toStrictEqual(true);
  });

  it("returns None for a plain string (not an object)", () => {
    expect(Option.isNone(restoreCommitSHA("a".repeat(40)))).toStrictEqual(true);
  });

  it("returns None for a number", () => {
    expect(Option.isNone(restoreCommitSHA(42))).toStrictEqual(true);
  });

  it("returns None for an array", () => {
    expect(Option.isNone(restoreCommitSHA(["a".repeat(40)]))).toStrictEqual(true);
  });

  it("returns None for SHA with spaces", () => {
    expect(Option.isNone(restoreCommitSHA({ sha: " " + "a".repeat(39) }))).toStrictEqual(true);
  });
});

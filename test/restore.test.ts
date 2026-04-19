import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  CommitSHARestoreError,
  GateConfigRestoreError,
  restoreCommitSHA,
  restoreGateConfig,
} from "../src/restore.js";

// ---------------------------------------------------------------------------
// restoreGateConfig
// ---------------------------------------------------------------------------

describe("restoreGateConfig — valid config", () => {
  it("restores a single-command config", () => {
    const data = { commands: ["npm test"], description: "Run tests" };
    const result = restoreGateConfig(data);
    expect(Either.isRight(result)).toStrictEqual(true);
    const value = Either.getOrThrow(result);
    expect(value.commands).toStrictEqual(["npm test"]);
    expect(value.description).toStrictEqual("Run tests");
  });

  it("restores a multi-command config", () => {
    const data = {
      commands: ["npm test", "npm run lint", "npm run build"],
      description: "Full CI",
    };
    const result = restoreGateConfig(data);
    expect(Either.isRight(result)).toStrictEqual(true);
    const value = Either.getOrThrow(result);
    expect(value.commands).toStrictEqual(["npm test", "npm run lint", "npm run build"]);
    expect(value.description).toStrictEqual("Full CI");
  });

  it("uses default description when description is missing", () => {
    const data = { commands: ["npm test"] };
    const result = restoreGateConfig(data);
    expect(Either.isRight(result)).toStrictEqual(true);
    const value = Either.getOrThrow(result);
    expect(value.description).toStrictEqual("Restored from session");
  });

  it("uses default description when description is not a string", () => {
    const data = { commands: ["npm test"], description: 42 };
    const result = restoreGateConfig(data);
    expect(Either.isRight(result)).toStrictEqual(true);
    const value = Either.getOrThrow(result);
    expect(value.description).toStrictEqual("Restored from session");
  });

  it("uses default description when description is null", () => {
    const data = { commands: ["npm test"], description: null };
    const result = restoreGateConfig(data);
    expect(Either.isRight(result)).toStrictEqual(true);
    const value = Either.getOrThrow(result);
    expect(value.description).toStrictEqual("Restored from session");
  });
});

describe("restoreGateConfig — InvalidCommand (fail closed)", () => {
  it("returns Left(InvalidCommand) on first invalid element", () => {
    const data = { commands: ["npm test", "", "  ", "npm run lint"], description: "test" };
    const result = restoreGateConfig(data);
    expect(result).toStrictEqual(Either.left(GateConfigRestoreError.InvalidCommand({ raw: "" })));
  });

  it("returns Left(InvalidCommand) when a single invalid command appears among valid ones", () => {
    const data = { commands: ["npm test", "npm run lint", ""], description: "test" };
    const result = restoreGateConfig(data);
    expect(result).toStrictEqual(Either.left(GateConfigRestoreError.InvalidCommand({ raw: "" })));
  });

  it("returns Left(InvalidCommand) when all commands are invalid", () => {
    const data = { commands: ["", "  "], description: "test" };
    const result = restoreGateConfig(data);
    expect(result).toStrictEqual(Either.left(GateConfigRestoreError.InvalidCommand({ raw: "" })));
  });

  it("returns Left(InvalidCommand) with the first non-string value", () => {
    const data = { commands: [42, "npm test", null, "npm run lint"], description: "test" };
    const result = restoreGateConfig(data);
    expect(result).toStrictEqual(Either.left(GateConfigRestoreError.InvalidCommand({ raw: 42 })));
  });
});

describe("restoreGateConfig — Tombstone", () => {
  it("returns Left(Tombstone) for cleared tombstone", () => {
    const data = { cleared: true };
    expect(restoreGateConfig(data)).toStrictEqual(
      Either.left(GateConfigRestoreError.Tombstone()),
    );
  });

  it("returns Left(Tombstone) for cleared tombstone even if commands present", () => {
    const data = { cleared: true, commands: ["npm test"] };
    expect(restoreGateConfig(data)).toStrictEqual(
      Either.left(GateConfigRestoreError.Tombstone()),
    );
  });

  it("does not treat cleared=false as a tombstone", () => {
    const data = { cleared: false, commands: ["npm test"], description: "test" };
    const result = restoreGateConfig(data);
    expect(Either.isRight(result)).toStrictEqual(true);
  });
});

describe("restoreGateConfig — NotARecord", () => {
  it("returns Left(NotARecord) for null", () => {
    expect(restoreGateConfig(null)).toStrictEqual(
      Either.left(GateConfigRestoreError.NotARecord()),
    );
  });

  it("returns Left(NotARecord) for undefined", () => {
    expect(restoreGateConfig(undefined)).toStrictEqual(
      Either.left(GateConfigRestoreError.NotARecord()),
    );
  });

  it("returns Left(NotARecord) for a plain string", () => {
    expect(restoreGateConfig("npm test")).toStrictEqual(
      Either.left(GateConfigRestoreError.NotARecord()),
    );
  });

  it("returns Left(NotARecord) for a number", () => {
    expect(restoreGateConfig(42)).toStrictEqual(
      Either.left(GateConfigRestoreError.NotARecord()),
    );
  });

  it("returns Left(NotARecord) for a top-level array", () => {
    expect(restoreGateConfig(["npm test"])).toStrictEqual(
      Either.left(GateConfigRestoreError.NotARecord()),
    );
  });
});

describe("restoreGateConfig — CommandsNotArray", () => {
  it("returns Left(CommandsNotArray) for empty record", () => {
    expect(restoreGateConfig({})).toStrictEqual(
      Either.left(GateConfigRestoreError.CommandsNotArray()),
    );
  });

  it("returns Left(CommandsNotArray) when commands is a string", () => {
    expect(restoreGateConfig({ commands: "npm test" })).toStrictEqual(
      Either.left(GateConfigRestoreError.CommandsNotArray()),
    );
  });

  it("returns Left(CommandsNotArray) when commands is null", () => {
    expect(restoreGateConfig({ commands: null })).toStrictEqual(
      Either.left(GateConfigRestoreError.CommandsNotArray()),
    );
  });

  it("returns Left(CommandsNotArray) when commands is a number", () => {
    expect(restoreGateConfig({ commands: 42 })).toStrictEqual(
      Either.left(GateConfigRestoreError.CommandsNotArray()),
    );
  });
});

describe("restoreGateConfig — CommandsEmpty", () => {
  it("returns Left(CommandsEmpty) for an empty commands array", () => {
    expect(restoreGateConfig({ commands: [] })).toStrictEqual(
      Either.left(GateConfigRestoreError.CommandsEmpty()),
    );
  });
});

// ---------------------------------------------------------------------------
// restoreCommitSHA
// ---------------------------------------------------------------------------

describe("restoreCommitSHA — valid data", () => {
  it("restores a valid 40-char lowercase hex SHA", () => {
    const sha = "a".repeat(40);
    const result = restoreCommitSHA({ sha });
    expect(Either.isRight(result)).toStrictEqual(true);
    expect(String(Either.getOrThrow(result))).toStrictEqual(sha);
  });

  it("restores a different valid SHA", () => {
    const sha = "deadbeef".repeat(5);
    const result = restoreCommitSHA({ sha });
    expect(Either.isRight(result)).toStrictEqual(true);
    expect(String(Either.getOrThrow(result))).toStrictEqual(sha);
  });

  it("restores SHA with mixed valid hex digits 0-9 and a-f", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const result = restoreCommitSHA({ sha });
    expect(Either.isRight(result)).toStrictEqual(true);
  });
});

describe("restoreCommitSHA — NotAString", () => {
  it("returns Left(NotAString) for null data", () => {
    expect(restoreCommitSHA(null)).toStrictEqual(
      Either.left(CommitSHARestoreError.NotAString()),
    );
  });

  it("returns Left(NotAString) for undefined data", () => {
    expect(restoreCommitSHA(undefined)).toStrictEqual(
      Either.left(CommitSHARestoreError.NotAString()),
    );
  });

  it("returns Left(NotAString) for empty object", () => {
    expect(restoreCommitSHA({})).toStrictEqual(
      Either.left(CommitSHARestoreError.NotAString()),
    );
  });

  it("returns Left(NotAString) when sha is a number", () => {
    expect(restoreCommitSHA({ sha: 42 })).toStrictEqual(
      Either.left(CommitSHARestoreError.NotAString()),
    );
  });

  it("returns Left(NotAString) when sha is null", () => {
    expect(restoreCommitSHA({ sha: null })).toStrictEqual(
      Either.left(CommitSHARestoreError.NotAString()),
    );
  });

  it("returns Left(NotAString) for a plain string (not an object)", () => {
    expect(restoreCommitSHA("a".repeat(40))).toStrictEqual(
      Either.left(CommitSHARestoreError.NotAString()),
    );
  });

  it("returns Left(NotAString) for a number", () => {
    expect(restoreCommitSHA(42)).toStrictEqual(
      Either.left(CommitSHARestoreError.NotAString()),
    );
  });

  it("returns Left(NotAString) for an array", () => {
    expect(restoreCommitSHA(["a".repeat(40)])).toStrictEqual(
      Either.left(CommitSHARestoreError.NotAString()),
    );
  });
});

describe("restoreCommitSHA — InvalidSHA", () => {
  it("returns Left(InvalidSHA) for SHA that is too short", () => {
    expect(restoreCommitSHA({ sha: "abcdef" })).toStrictEqual(
      Either.left(CommitSHARestoreError.InvalidSHA({ raw: "abcdef" })),
    );
  });

  it("returns Left(InvalidSHA) for SHA that is too long (41 chars)", () => {
    const raw = "a".repeat(41);
    expect(restoreCommitSHA({ sha: raw })).toStrictEqual(
      Either.left(CommitSHARestoreError.InvalidSHA({ raw })),
    );
  });

  it("returns Left(InvalidSHA) for SHA with uppercase hex", () => {
    const raw = "A".repeat(40);
    expect(restoreCommitSHA({ sha: raw })).toStrictEqual(
      Either.left(CommitSHARestoreError.InvalidSHA({ raw })),
    );
  });

  it("returns Left(InvalidSHA) for SHA with non-hex characters", () => {
    const raw = "g".repeat(40);
    expect(restoreCommitSHA({ sha: raw })).toStrictEqual(
      Either.left(CommitSHARestoreError.InvalidSHA({ raw })),
    );
  });

  it("returns Left(InvalidSHA) for empty string SHA", () => {
    expect(restoreCommitSHA({ sha: "" })).toStrictEqual(
      Either.left(CommitSHARestoreError.InvalidSHA({ raw: "" })),
    );
  });

  it("returns Left(InvalidSHA) for SHA with spaces", () => {
    const raw = " " + "a".repeat(39);
    expect(restoreCommitSHA({ sha: raw })).toStrictEqual(
      Either.left(CommitSHARestoreError.InvalidSHA({ raw })),
    );
  });
});

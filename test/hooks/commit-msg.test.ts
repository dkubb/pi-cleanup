import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const hookPath = fileURLToPath(new URL("../../scripts/hooks/commit-msg", import.meta.url));

interface HookResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

const runHook = (message: string): HookResult => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-cleanup-commit-msg-"));
  const messagePath = join(tempDir, "COMMIT_EDITMSG");

  writeFileSync(messagePath, message, "utf8");

  try {
    const result = spawnSync(hookPath, [messagePath], {
      encoding: "utf8",
    });

    return {
      exitCode: result.status,
      stderr: result.stderr,
    };
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
};

describe("scripts/hooks/commit-msg", () => {
  it("accepts a valid message with wrapped body lines", () => {
    const result = runHook(
      [
        "build(hooks): add commit message guard",
        "",
        "Install the repo-local commit-msg hook.",
        "",
        "This body stays within the configured width.",
      ].join("\n"),
    );

    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  it("accepts a 70-character subject line", () => {
    const subject = `build(hooks): ${"a".repeat(56)}`;
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect({
      exitCode: result.exitCode,
      stderr: result.stderr,
      subjectLength: subject.length,
    }).toStrictEqual({
      exitCode: 0,
      stderr: "",
      subjectLength: 70,
    });
  });

  it("rejects a subject line longer than 70 characters", () => {
    const subject = `build(hooks): ${"a".repeat(57)}`;
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect({
      exitCode: result.exitCode,
      stderrIncludesRule: result.stderr.includes("subject too long"),
      stderrIncludesOffendingText: result.stderr.includes(subject),
      stderrIncludesHint: result.stderr.includes("git conventional-commit"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesRule: true,
      stderrIncludesOffendingText: true,
      stderrIncludesHint: true,
    });
  });

  it("accepts a subject with an allowed type, scope, and breaking marker", () => {
    const subject = "feat(parser)!: add subject validation";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  it("accepts an autosquash subject created by git conventional-commit reword", () => {
    const subject = "amend! build(hooks): validate conventional commit subjects";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  it("rejects a subject with an invalid type", () => {
    const subject = "feature(parser): add subject validation";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect({
      exitCode: result.exitCode,
      stderrIncludesRule: result.stderr.includes("invalid type"),
      stderrIncludesOffendingText: result.stderr.includes(subject),
      stderrIncludesHint: result.stderr.includes("git conventional-commit"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesRule: true,
      stderrIncludesOffendingText: true,
      stderrIncludesHint: true,
    });
  });

  it("rejects a subject with nested scope parentheses", () => {
    const subject = "feat(api(v1)): add subject validation";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect({
      exitCode: result.exitCode,
      stderrIncludesRule: result.stderr.includes("invalid scope"),
      stderrIncludesOffendingText: result.stderr.includes(subject),
      stderrIncludesHint: result.stderr.includes("git conventional-commit"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesRule: true,
      stderrIncludesOffendingText: true,
      stderrIncludesHint: true,
    });
  });

  it("accepts a subject with a non-empty description", () => {
    const subject = "fix: keep description present";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  it("rejects a subject with an empty description", () => {
    const subject = "fix: ";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect({
      exitCode: result.exitCode,
      stderrIncludesRule: result.stderr.includes("empty description"),
      stderrIncludesOffendingText: result.stderr.includes(subject),
      stderrIncludesHint: result.stderr.includes("git conventional-commit"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesRule: true,
      stderrIncludesOffendingText: true,
      stderrIncludesHint: true,
    });
  });

  it("accepts a subject description without a trailing period", () => {
    const subject = "docs: explain hook usage";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  it("rejects a subject description with a trailing period", () => {
    const subject = "docs: explain hook usage.";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect({
      exitCode: result.exitCode,
      stderrIncludesRule: result.stderr.includes("trailing period"),
      stderrIncludesOffendingText: result.stderr.includes(subject),
      stderrIncludesHint: result.stderr.includes("git conventional-commit"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesRule: true,
      stderrIncludesOffendingText: true,
      stderrIncludesHint: true,
    });
  });

  it("accepts a subject description that starts with a lowercase letter", () => {
    const subject = "refactor: keep description lowercase";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  it("rejects a subject description that starts with an uppercase letter", () => {
    const subject = "refactor: Keep description lowercase";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect({
      exitCode: result.exitCode,
      stderrIncludesRule: result.stderr.includes("capitalized description"),
      stderrIncludesOffendingText: result.stderr.includes(subject),
      stderrIncludesHint: result.stderr.includes("git conventional-commit"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesRule: true,
      stderrIncludesOffendingText: true,
      stderrIncludesHint: true,
    });
  });

  it("accepts an atomic subject without connective words", () => {
    const subject = "test: cover subject validation";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  it("rejects a subject with an and connective", () => {
    const subject = "test: cover subject validation and wrap body";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect({
      exitCode: result.exitCode,
      stderrIncludesRule: result.stderr.includes("non-atomic subject"),
      stderrIncludesOffendingText: result.stderr.includes(subject),
      stderrIncludesHint: result.stderr.includes("git conventional-commit"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesRule: true,
      stderrIncludesOffendingText: true,
      stderrIncludesHint: true,
    });
  });

  it("rejects a subject with an or connective", () => {
    const subject = "test: cover subject validation or wrap body";
    const result = runHook([subject, "", "Body line stays short."].join("\n"));

    expect({
      exitCode: result.exitCode,
      stderrIncludesRule: result.stderr.includes("non-atomic subject"),
      stderrIncludesOffendingText: result.stderr.includes(subject),
      stderrIncludesHint: result.stderr.includes("git conventional-commit"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesRule: true,
      stderrIncludesOffendingText: true,
      stderrIncludesHint: true,
    });
  });

  it("ignores git comment lines even when they are long", () => {
    const result = runHook(
      [
        "build(hooks): ignore comment lines",
        "",
        "# This git comment line is intentionally much longer than seventy-two characters and is ignored.",
        "Body line stays short.",
      ].join("\n"),
    );

    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  it("rejects a body line longer than 72 characters and reports the line number", () => {
    const result = runHook(
      [
        "build(hooks): reject long body line",
        "",
        "This body line is intentionally made longer than seventy-two characters to fail.",
      ].join("\n"),
    );

    expect({
      exitCode: result.exitCode,
      stderrIncludesLine: result.stderr.includes("line 3"),
      stderrIncludesLength: result.stderr.includes("80 chars"),
      stderrIncludesHint: result.stderr.includes("git conventional-commit"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesLine: true,
      stderrIncludesLength: true,
      stderrIncludesHint: true,
    });
  });

  it("rejects a trailer line longer than 72 characters", () => {
    const result = runHook(
      [
        "build(hooks): reject long trailer",
        "",
        "Body line stays short.",
        "",
        "Co-authored-by: Example Person <example.person.with.a.very.long.email.address@example.com>",
      ].join("\n"),
    );

    expect({
      exitCode: result.exitCode,
      stderrIncludesLine: result.stderr.includes("line 5"),
      stderrIncludesLength: result.stderr.includes("90 chars"),
    }).toStrictEqual({
      exitCode: 1,
      stderrIncludesLine: true,
      stderrIncludesLength: true,
    });
  });
});

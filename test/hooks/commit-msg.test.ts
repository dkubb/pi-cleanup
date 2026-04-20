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

  it("does not enforce the 72-character limit on the subject line", () => {
    const result = runHook(
      [
        "build(hooks): this subject is intentionally longer than seventy-two characters for coverage",
        "",
        "Body line stays short.",
      ].join("\n"),
    );

    expect(result).toStrictEqual({
      exitCode: 0,
      stderr: "",
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

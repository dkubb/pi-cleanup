import { describe, expect, it } from "vitest";
import type { ExecResult } from "@mariozechner/pi-coding-agent";
import { buildDirtyTreeMessage, checkGitStatus, isGitRepo } from "../../src/phases/dirty-tree.js";
import type { ExecFn } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const makeExec = (result: ExecResult): ExecFn =>
  async (_cmd, _args, _opts) => result;

const execClean: ExecFn = makeExec({ code: 0, stdout: "", stderr: "" });
const execCleanWhitespace: ExecFn = makeExec({ code: 0, stdout: "   \n  ", stderr: "" });
const execDirty: ExecFn = makeExec({ code: 0, stdout: "M  foo.ts\n?? bar.ts", stderr: "" });
const execNotARepo128: ExecFn = makeExec({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
const execNotARepo1: ExecFn = makeExec({ code: 1, stdout: "", stderr: "error" });

// ---------------------------------------------------------------------------
// isGitRepo
// ---------------------------------------------------------------------------

describe("isGitRepo", () => {
  it("returns true when git rev-parse --git-dir exits with code 0", async () => {
    const exec = makeExec({ code: 0, stdout: ".git", stderr: "" });
    const result = await isGitRepo(exec);
    expect(result).toStrictEqual(true);
  });

  it("returns false when git rev-parse --git-dir exits with non-zero code", async () => {
    const exec = makeExec({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    const result = await isGitRepo(exec);
    expect(result).toStrictEqual(false);
  });

  it("returns false when exit code is 1", async () => {
    const exec = makeExec({ code: 1, stdout: "", stderr: "error" });
    const result = await isGitRepo(exec);
    expect(result).toStrictEqual(false);
  });

  it("calls exec with correct git rev-parse arguments", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: ".git", stderr: "" };
    };

    await isGitRepo(trackingExec);

    expect(calls).toStrictEqual([{ cmd: "git", args: ["rev-parse", "--git-dir"] }]);
  });
});

// ---------------------------------------------------------------------------
// checkGitStatus
// ---------------------------------------------------------------------------

describe("checkGitStatus", () => {
  it("returns Clean when stdout is empty", async () => {
    const result = await checkGitStatus(execClean);
    expect(result._tag).toStrictEqual("Clean");
  });

  it("returns Clean when stdout is only whitespace", async () => {
    const result = await checkGitStatus(execCleanWhitespace);
    expect(result._tag).toStrictEqual("Clean");
  });

  it("returns Dirty with trimmed porcelain output", async () => {
    const result = await checkGitStatus(execDirty);
    expect(result._tag).toStrictEqual("Dirty");
    const resultDirty = result as Extract<typeof result, { _tag: "Dirty" }>;
    expect(resultDirty.porcelain).toStrictEqual("M  foo.ts\n?? bar.ts");
  });

  it("returns Dirty preserving multi-line porcelain output", async () => {
    const porcelain = " M staged.ts\n?? untracked.ts\nD  deleted.ts";
    const exec = makeExec({ code: 0, stdout: porcelain, stderr: "" });
    const result = await checkGitStatus(exec);
    expect(result._tag).toStrictEqual("Dirty");
    const resultDirty = result as Extract<typeof result, { _tag: "Dirty" }>;
    expect(resultDirty.porcelain).toStrictEqual(porcelain.trim());
  });

  it("returns NotARepo when exit code is 128", async () => {
    const result = await checkGitStatus(execNotARepo128);
    expect(result._tag).toStrictEqual("NotARepo");
  });

  it("returns NotARepo when exit code is 1 (any non-zero)", async () => {
    const result = await checkGitStatus(execNotARepo1);
    expect(result._tag).toStrictEqual("NotARepo");
  });

  it("returns NotARepo when exit code is 2", async () => {
    const exec = makeExec({ code: 2, stdout: "", stderr: "some error" });
    const result = await checkGitStatus(exec);
    expect(result._tag).toStrictEqual("NotARepo");
  });

  it("calls exec with correct git arguments", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "" };
    };

    await checkGitStatus(trackingExec);

    expect(calls).toStrictEqual([{ cmd: "git", args: ["status", "--porcelain=v1"] }]);
  });

  it("trims leading/trailing whitespace from porcelain output", async () => {
    const exec = makeExec({ code: 0, stdout: "\nM foo.ts\n", stderr: "" });
    const result = await checkGitStatus(exec);
    expect(result._tag).toStrictEqual("Dirty");
    const resultDirty = result as Extract<typeof result, { _tag: "Dirty" }>;
    expect(resultDirty.porcelain).toStrictEqual("M foo.ts");
  });
});

// ---------------------------------------------------------------------------
// buildDirtyTreeMessage
// ---------------------------------------------------------------------------

describe("buildDirtyTreeMessage", () => {
  it("returns the exact expected message with porcelain in a code block", () => {
    const msg = buildDirtyTreeMessage("M foo.ts\n?? bar.ts");

    expect(msg).toStrictEqual(
      [
        "All quality gates pass. There are uncommitted changes in the working tree.",
        "",
        "Please stage and commit each logical change as its own atomic commit using the",
        "`git conventional-commit` wrapper (not raw `git commit`). Subject <= 70 chars;",
        "commit body paragraphs wrapped at 72 chars. One conventional type per commit.",
        "",
        "```<porcelain>",
        "M foo.ts",
        "?? bar.ts",
        "```",
      ].join("\n"),
    );
  });

  it("works with single-file porcelain", () => {
    const msg = buildDirtyTreeMessage("A new.ts");

    expect(msg).toStrictEqual(
      [
        "All quality gates pass. There are uncommitted changes in the working tree.",
        "",
        "Please stage and commit each logical change as its own atomic commit using the",
        "`git conventional-commit` wrapper (not raw `git commit`). Subject <= 70 chars;",
        "commit body paragraphs wrapped at 72 chars. One conventional type per commit.",
        "",
        "```<porcelain>",
        "A new.ts",
        "```",
      ].join("\n"),
    );
  });
});

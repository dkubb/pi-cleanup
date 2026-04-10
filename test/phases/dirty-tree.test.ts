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
    expect(result).toBe(true);
  });

  it("returns false when git rev-parse --git-dir exits with non-zero code", async () => {
    const exec = makeExec({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    const result = await isGitRepo(exec);
    expect(result).toBe(false);
  });

  it("returns false when exit code is 1", async () => {
    const exec = makeExec({ code: 1, stdout: "", stderr: "error" });
    const result = await isGitRepo(exec);
    expect(result).toBe(false);
  });

  it("calls exec with correct git rev-parse arguments", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: ".git", stderr: "" };
    };

    await isGitRepo(trackingExec);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("git");
    expect(calls[0]!.args).toEqual(["rev-parse", "--git-dir"]);
  });
});

// ---------------------------------------------------------------------------
// checkGitStatus
// ---------------------------------------------------------------------------

describe("checkGitStatus", () => {
  it("returns Clean when stdout is empty", async () => {
    const result = await checkGitStatus(execClean);
    expect(result._tag).toBe("Clean");
  });

  it("returns Clean when stdout is only whitespace", async () => {
    const result = await checkGitStatus(execCleanWhitespace);
    expect(result._tag).toBe("Clean");
  });

  it("returns Dirty with trimmed porcelain output", async () => {
    const result = await checkGitStatus(execDirty);
    expect(result._tag).toBe("Dirty");
    if (result._tag === "Dirty") {
      expect(result.porcelain).toBe("M  foo.ts\n?? bar.ts");
    }
  });

  it("returns Dirty preserving multi-line porcelain output", async () => {
    const porcelain = " M staged.ts\n?? untracked.ts\nD  deleted.ts";
    const exec = makeExec({ code: 0, stdout: porcelain, stderr: "" });
    const result = await checkGitStatus(exec);
    expect(result._tag).toBe("Dirty");
    if (result._tag === "Dirty") {
      expect(result.porcelain).toBe(porcelain.trim());
    }
  });

  it("returns NotARepo when exit code is 128", async () => {
    const result = await checkGitStatus(execNotARepo128);
    expect(result._tag).toBe("NotARepo");
  });

  it("returns NotARepo when exit code is 1 (any non-zero)", async () => {
    const result = await checkGitStatus(execNotARepo1);
    expect(result._tag).toBe("NotARepo");
  });

  it("returns NotARepo when exit code is 2", async () => {
    const exec = makeExec({ code: 2, stdout: "", stderr: "some error" });
    const result = await checkGitStatus(exec);
    expect(result._tag).toBe("NotARepo");
  });

  it("calls exec with correct git arguments", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: ExecFn = async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "", stderr: "" };
    };

    await checkGitStatus(trackingExec);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("git");
    expect(calls[0]!.args).toEqual(["status", "--porcelain=v1"]);
  });

  it("trims leading/trailing whitespace from porcelain output", async () => {
    const exec = makeExec({ code: 0, stdout: "\nM foo.ts\n", stderr: "" });
    const result = await checkGitStatus(exec);
    expect(result._tag).toBe("Dirty");
    if (result._tag === "Dirty") {
      expect(result.porcelain).toBe("M foo.ts");
    }
  });
});

// ---------------------------------------------------------------------------
// buildDirtyTreeMessage
// ---------------------------------------------------------------------------

describe("buildDirtyTreeMessage", () => {
  it("includes the porcelain output in a fenced code block", () => {
    const msg = buildDirtyTreeMessage("M foo.ts\n?? bar.ts");
    expect(msg).toContain("M foo.ts\n?? bar.ts");
    expect(msg).toContain("```");
  });

  it("mentions committing and conventional commit format", () => {
    const msg = buildDirtyTreeMessage("M foo.ts");
    expect(msg.toLowerCase()).toContain("commit");
    expect(msg.toLowerCase()).toContain("conventional commit");
  });

  it("mentions uncommitted changes", () => {
    const msg = buildDirtyTreeMessage("M foo.ts");
    expect(msg.toLowerCase()).toContain("uncommitted changes");
  });

  it("wraps porcelain in a fenced code block with opening and closing fences", () => {
    const msg = buildDirtyTreeMessage("M foo.ts");
    const lines = msg.split("\n");
    const fenceLines = lines.filter((l) => l === "```");
    expect(fenceLines.length).toBeGreaterThanOrEqual(2);
  });

  it("works with single-file porcelain output", () => {
    const msg = buildDirtyTreeMessage("M single.ts");
    expect(msg).toContain("single.ts");
  });

  it("works with multi-file porcelain output", () => {
    const porcelain = "M a.ts\nA b.ts\nD c.ts\n?? d.ts";
    const msg = buildDirtyTreeMessage(porcelain);
    expect(msg).toContain("a.ts");
    expect(msg).toContain("b.ts");
    expect(msg).toContain("c.ts");
    expect(msg).toContain("d.ts");
  });

  it("mentions quality gates", () => {
    const msg = buildDirtyTreeMessage("M foo.ts");
    expect(msg.toLowerCase()).toContain("quality gate");
  });

  it("returns a non-empty string", () => {
    const msg = buildDirtyTreeMessage("M foo.ts");
    expect(msg.length).toBeGreaterThan(0);
  });
});

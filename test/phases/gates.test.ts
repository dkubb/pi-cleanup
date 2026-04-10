import { describe, expect, it } from "vitest";
import type { ExecResult } from "@mariozechner/pi-coding-agent";
import { buildGateFixMessage, runGates } from "../../src/phases/gates.js";
import { type ExecFn, type GateCommand, type GateConfig, decodeGateCommand } from "../../src/types.js";
import { Either } from "effect";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const cmd = (s: string): GateCommand => Either.getOrThrow(decodeGateCommand(s));

const makeConfig = (commands: GateCommand[], description = "test gates"): GateConfig => ({
  commands: commands as [GateCommand, ...GateCommand[]],
  description,
});

const makeExec = (result: ExecResult): ExecFn =>
  async (_cmd, _args, _opts) => result;

const passExec: ExecFn = makeExec({ code: 0, stdout: "ok", stderr: "" });
const failExec: ExecFn = makeExec({ code: 1, stdout: "FAIL", stderr: "details" });

// ---------------------------------------------------------------------------
// runGates — all passed
// ---------------------------------------------------------------------------

describe("runGates — all passed", () => {
  it("returns AllPassed when single command succeeds", async () => {
    const config = makeConfig([cmd("true")]);
    const result = await runGates(passExec, config);
    expect(result._tag).toBe("AllPassed");
  });

  it("returns AllPassed when all commands succeed", async () => {
    const config = makeConfig([cmd("npm test"), cmd("npm run lint"), cmd("npm run build")]);
    const result = await runGates(passExec, config);
    expect(result._tag).toBe("AllPassed");
  });

  it("calls exec with bash -c <command> for each gate", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: ExecFn = async (command, args, _opts) => {
      calls.push({ cmd: command, args });
      return { code: 0, stdout: "", stderr: "" };
    };

    const config = makeConfig([cmd("npm test"), cmd("npm run lint")]);
    await runGates(trackingExec, config);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe("bash");
    expect(calls[0]!.args).toEqual(["-c", "npm test"]);
    expect(calls[1]!.cmd).toBe("bash");
    expect(calls[1]!.args).toEqual(["-c", "npm run lint"]);
  });

  it("passes timeout option of 120000ms", async () => {
    const capturedOpts: unknown[] = [];
    const trackingExec: ExecFn = async (_cmd, _args, opts) => {
      capturedOpts.push(opts);
      return { code: 0, stdout: "", stderr: "" };
    };

    const config = makeConfig([cmd("npm test")]);
    await runGates(trackingExec, config);

    expect(capturedOpts[0]).toEqual({ timeout: 120_000 });
  });
});

// ---------------------------------------------------------------------------
// runGates — first failure
// ---------------------------------------------------------------------------

describe("runGates — failure", () => {
  it("returns Failed with command and output when gate fails", async () => {
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(failExec, config);
    expect(result._tag).toBe("Failed");
    if (result._tag === "Failed") {
      expect(result.command).toBe("npm test");
      expect(result.output).toContain("FAIL");
    }
  });

  it("combines stdout and stderr into output", async () => {
    const exec: ExecFn = makeExec({ code: 1, stdout: "stdout content", stderr: "stderr content" });
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(exec, config);
    expect(result._tag).toBe("Failed");
    if (result._tag === "Failed") {
      expect(result.output).toContain("stdout content");
      expect(result.output).toContain("stderr content");
    }
  });

  it("stops at first failure — does not run remaining gates", async () => {
    let callCount = 0;
    const partialFailExec: ExecFn = async (_cmd, args) => {
      callCount++;
      const command = args[1];
      return command === "npm test"
        ? { code: 1, stdout: "FAIL", stderr: "" }
        : { code: 0, stdout: "ok", stderr: "" };
    };

    const config = makeConfig([cmd("npm test"), cmd("npm run lint"), cmd("npm run build")]);
    const result = await runGates(partialFailExec, config);

    expect(result._tag).toBe("Failed");
    expect(callCount).toBe(1);
  });

  it("returns the first failing command, not a later one", async () => {
    let callCount = 0;
    const failSecondExec: ExecFn = async (_cmd, args) => {
      callCount++;
      const command = args[1];
      return command === "npm run lint"
        ? { code: 1, stdout: "lint error", stderr: "" }
        : { code: 0, stdout: "ok", stderr: "" };
    };

    const config = makeConfig([cmd("npm test"), cmd("npm run lint"), cmd("npm run build")]);
    const result = await runGates(failSecondExec, config);

    expect(result._tag).toBe("Failed");
    if (result._tag === "Failed") {
      expect(result.command).toBe("npm run lint");
    }
    expect(callCount).toBe(2);
  });

  it("handles only stderr in output (no stdout)", async () => {
    const exec: ExecFn = makeExec({ code: 1, stdout: "", stderr: "stderr only" });
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(exec, config);
    expect(result._tag).toBe("Failed");
    if (result._tag === "Failed") {
      expect(result.output).toBe("stderr only");
    }
  });

  it("handles only stdout in output (no stderr)", async () => {
    const exec: ExecFn = makeExec({ code: 1, stdout: "stdout only", stderr: "" });
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(exec, config);
    expect(result._tag).toBe("Failed");
    if (result._tag === "Failed") {
      expect(result.output).toBe("stdout only");
    }
  });

  it("handles empty stdout and stderr on failure", async () => {
    const exec: ExecFn = makeExec({ code: 1, stdout: "", stderr: "" });
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(exec, config);
    expect(result._tag).toBe("Failed");
    if (result._tag === "Failed") {
      expect(result.output).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// runGates — pass then fail
// ---------------------------------------------------------------------------

describe("runGates — pass then fail sequence", () => {
  it("runs all gates in order until failure", async () => {
    const order: string[] = [];
    const seqExec: ExecFn = async (_cmd, args) => {
      const command = args[1] as string;
      order.push(command);
      return command === "fail-cmd"
        ? { code: 1, stdout: "failed", stderr: "" }
        : { code: 0, stdout: "ok", stderr: "" };
    };

    const config = makeConfig([cmd("pass1"), cmd("pass2"), cmd("fail-cmd"), cmd("never-run")]);
    await runGates(seqExec, config);

    expect(order).toEqual(["pass1", "pass2", "fail-cmd"]);
  });
});

// ---------------------------------------------------------------------------
// buildGateFixMessage
// ---------------------------------------------------------------------------

describe("buildGateFixMessage", () => {
  it("includes the failed command name", () => {
    const msg = buildGateFixMessage(cmd("npm test"), "FAIL: 2 tests");
    expect(msg).toContain("npm test");
  });

  it("includes the failure output", () => {
    const msg = buildGateFixMessage(cmd("npm test"), "FAIL: 2 tests");
    expect(msg).toContain("FAIL: 2 tests");
  });

  it("wraps output in a fenced code block", () => {
    const msg = buildGateFixMessage(cmd("npm test"), "some output");
    expect(msg).toContain("```");
    const lines = msg.split("\n");
    const fenceCount = lines.filter((l) => l === "```").length;
    expect(fenceCount).toBeGreaterThanOrEqual(2);
  });

  it("asks the agent to fix the issue and commit", () => {
    const msg = buildGateFixMessage(cmd("npm test"), "error");
    expect(msg.toLowerCase()).toContain("fix");
    expect(msg.toLowerCase()).toContain("commit");
  });

  it("includes 'quality gate failed' context", () => {
    const msg = buildGateFixMessage(cmd("npm test"), "error");
    expect(msg.toLowerCase()).toContain("quality gate failed");
  });

  it("formats command in backticks inline", () => {
    const msg = buildGateFixMessage(cmd("npm test"), "error");
    expect(msg).toContain("`npm test`");
  });

  it("works with multi-line output", () => {
    const output = "line 1\nline 2\nline 3";
    const msg = buildGateFixMessage(cmd("npm test"), output);
    expect(msg).toContain("line 1");
    expect(msg).toContain("line 2");
    expect(msg).toContain("line 3");
  });

  it("works with complex command names", () => {
    const msg = buildGateFixMessage(cmd("npx tsc --noEmit"), "error");
    expect(msg).toContain("npx tsc --noEmit");
  });

  it("returns a non-empty string", () => {
    const msg = buildGateFixMessage(cmd("npm test"), "error");
    expect(msg.length).toBeGreaterThan(0);
  });
});

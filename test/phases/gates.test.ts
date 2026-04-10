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
    expect(result._tag).toStrictEqual("AllPassed");
  });

  it("returns AllPassed when all commands succeed", async () => {
    const config = makeConfig([cmd("npm test"), cmd("npm run lint"), cmd("npm run build")]);
    const result = await runGates(passExec, config);
    expect(result._tag).toStrictEqual("AllPassed");
  });

  it("calls exec with bash -c <command> for each gate", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const trackingExec: ExecFn = async (command, args, _opts) => {
      calls.push({ cmd: command, args });
      return { code: 0, stdout: "", stderr: "" };
    };

    const config = makeConfig([cmd("npm test"), cmd("npm run lint")]);
    await runGates(trackingExec, config);

    expect(calls).toStrictEqual([
      { cmd: "bash", args: ["-c", "npm test"] },
      { cmd: "bash", args: ["-c", "npm run lint"] },
    ]);
  });

  it("passes timeout option of 120000ms", async () => {
    const capturedOpts: unknown[] = [];
    const trackingExec: ExecFn = async (_cmd, _args, opts) => {
      capturedOpts.push(opts);
      return { code: 0, stdout: "", stderr: "" };
    };

    const config = makeConfig([cmd("npm test")]);
    await runGates(trackingExec, config);

    expect(capturedOpts[0]).toStrictEqual({ timeout: 120_000 });
  });
});

// ---------------------------------------------------------------------------
// runGates — first failure
// ---------------------------------------------------------------------------

describe("runGates — failure", () => {
  it("returns Failed with command and output when gate fails", async () => {
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(failExec, config);
    expect(result._tag).toStrictEqual("Failed");
    if (result._tag === "Failed") {
      expect(result.command).toStrictEqual("npm test");
      expect(result.output).toStrictEqual("FAIL\ndetails");
    }
  });

  it("combines stdout and stderr into output", async () => {
    const exec: ExecFn = makeExec({ code: 1, stdout: "stdout content", stderr: "stderr content" });
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(exec, config);
    expect(result._tag).toStrictEqual("Failed");
    if (result._tag === "Failed") {
      expect(result.output).toStrictEqual("stdout content\nstderr content");
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

    expect(result._tag).toStrictEqual("Failed");
    expect(callCount).toStrictEqual(1);
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

    expect(result._tag).toStrictEqual("Failed");
    if (result._tag === "Failed") {
      expect(result.command).toStrictEqual("npm run lint");
    }
    expect(callCount).toStrictEqual(2);
  });

  it("handles only stderr in output (no stdout)", async () => {
    const exec: ExecFn = makeExec({ code: 1, stdout: "", stderr: "stderr only" });
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(exec, config);
    expect(result._tag).toStrictEqual("Failed");
    if (result._tag === "Failed") {
      expect(result.output).toStrictEqual("stderr only");
    }
  });

  it("handles only stdout in output (no stderr)", async () => {
    const exec: ExecFn = makeExec({ code: 1, stdout: "stdout only", stderr: "" });
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(exec, config);
    expect(result._tag).toStrictEqual("Failed");
    if (result._tag === "Failed") {
      expect(result.output).toStrictEqual("stdout only");
    }
  });

  it("handles empty stdout and stderr on failure", async () => {
    const exec: ExecFn = makeExec({ code: 1, stdout: "", stderr: "" });
    const config = makeConfig([cmd("npm test")]);
    const result = await runGates(exec, config);
    expect(result._tag).toStrictEqual("Failed");
    if (result._tag === "Failed") {
      expect(result.output).toStrictEqual("");
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

    expect(order).toStrictEqual(["pass1", "pass2", "fail-cmd"]);
  });
});

// ---------------------------------------------------------------------------
// buildGateFixMessage
// ---------------------------------------------------------------------------

describe("buildGateFixMessage", () => {
  it("returns the exact expected message with command and output", () => {
    const msg = buildGateFixMessage(cmd("npm test"), "FAIL: 2 tests");

    expect(msg).toStrictEqual(
      [
        "Quality gate failed: `npm test`",
        "",
        "```",
        "FAIL: 2 tests",
        "```",
        "",
        "Please fix the issue and commit the fix.",
      ].join("\n"),
    );
  });

  it("works with multi-line output", () => {
    const msg = buildGateFixMessage(cmd("just check"), "line 1\nline 2");

    expect(msg).toStrictEqual(
      [
        "Quality gate failed: `just check`",
        "",
        "```",
        "line 1",
        "line 2",
        "```",
        "",
        "Please fix the issue and commit the fix.",
      ].join("\n"),
    );
  });
});

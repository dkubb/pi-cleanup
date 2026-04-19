import { describe, expect, it } from "vitest";
import { Either, Option } from "effect";
import {
  buildFactorMessage,
  checkAtomicity,
  getDefaultBaseSHA,
} from "../../src/phases/atomicity.js";
import { type CommitSHA, type ExecFn, type GateCommand, decodeCommitSHA, decodeGateCommand } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const sha = (c: string): CommitSHA => Either.getOrThrow(decodeCommitSHA(c.repeat(40).slice(0, 40)));
const cmd = (s: string): GateCommand => Either.getOrThrow(decodeGateCommand(s));

const sha1 = sha("a");
const sha2 = sha("b");
const sha3 = sha("c");

type ExecCall = { cmd: string; args: string[] };

// Build an ExecFn from a map of arg-pattern → result
const makeExecMap = (map: Record<string, { code: number; stdout: string }>): ExecFn =>
  async (_cmd, args) => {
    const key = args.join(" ");
    const entry = map[key];
    return entry !== undefined
      ? { code: entry.code, stdout: entry.stdout, stderr: "" }
      : { code: 1, stdout: "", stderr: "no match" };
  };

// ---------------------------------------------------------------------------
// getDefaultBaseSHA
// ---------------------------------------------------------------------------

describe("getDefaultBaseSHA", () => {
  it("returns Some(sha) when main branch exists", async () => {
    const exec = makeExecMap({
      "merge-base HEAD main": { code: 0, stdout: sha1 + "\n" },
    });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value).toStrictEqual(sha1);
  });

  it("falls back to master when main does not exist", async () => {
    const exec = makeExecMap({
      "merge-base HEAD master": { code: 0, stdout: sha2 + "\n" },
    });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value).toStrictEqual(sha2);
  });

  it("falls back to develop when main and master do not exist", async () => {
    const exec = makeExecMap({
      "merge-base HEAD develop": { code: 0, stdout: sha3 + "\n" },
    });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value).toStrictEqual(sha3);
  });

  it("returns None when no default branches exist", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "not found" });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isNone(result)).toStrictEqual(true);
  });

  it("prefers main over master (returns main when both exist)", async () => {
    const exec = makeExecMap({
      "merge-base HEAD main": { code: 0, stdout: sha1 + "\n" },
      "merge-base HEAD master": { code: 0, stdout: sha2 + "\n" },
    });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value).toStrictEqual(sha1);
  });

  it("prefers master over develop (returns master when main absent)", async () => {
    const exec = makeExecMap({
      "merge-base HEAD master": { code: 0, stdout: sha2 + "\n" },
      "merge-base HEAD develop": { code: 0, stdout: sha3 + "\n" },
    });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isSome(result)).toStrictEqual(true);
    const value = (result as Option.Some<typeof result.value>).value;
    expect(value).toStrictEqual(sha2);
  });

  it("returns None when merge-base returns invalid SHA", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "not-a-sha\n", stderr: "" });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isNone(result)).toStrictEqual(true);
  });

  it("calls git merge-base HEAD <branch>", async () => {
    const calls: ExecCall[] = [];
    const trackingExec: ExecFn = async (command, args) => {
      calls.push({ cmd: command, args });
      return { code: 1, stdout: "", stderr: "" };
    };

    await getDefaultBaseSHA(trackingExec);

    expect(calls[0]).toStrictEqual({ cmd: "git", args: ["merge-base", "HEAD", "main"] });
  });
});

// ---------------------------------------------------------------------------
// checkAtomicity — Indeterminate (HEAD not resolved)
// ---------------------------------------------------------------------------

describe("checkAtomicity — Indeterminate", () => {
  it("returns Indeterminate when rev-parse HEAD fails", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "fatal" });
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toStrictEqual("Indeterminate");
  });

  it("returns Indeterminate when HEAD SHA is invalid", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "not-a-sha\n", stderr: "" });
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toStrictEqual("Indeterminate");
  });

  it("returns Indeterminate when stdout is empty", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" });
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toStrictEqual("Indeterminate");
  });
});

// ---------------------------------------------------------------------------
// checkAtomicity — NoBase
// ---------------------------------------------------------------------------

describe("checkAtomicity — NoBase", () => {
  it("returns NoBase when merge-base equals HEAD (working on default branch)", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "merge-base": { code: 0, stdout: sha1 + "\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toStrictEqual("NoBase");
    const resultNoBase = result as Extract<typeof result, { _tag: "NoBase" }>;
    expect(resultNoBase.headSHA).toStrictEqual(sha1);
  });
});

describe("checkAtomicity — empty tree fallback", () => {
  it("uses empty tree SHA when no lastCleanSHA and no default branches", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "merge-base": { code: 1, stdout: "", stderr: "no branch" },
        "rev-list": { code: 0, stdout: "1\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toStrictEqual("Atomic");
  });

  it("returns NeedsFactoring with empty tree base when multiple commits", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "merge-base": { code: 1, stdout: "", stderr: "no branch" },
        "rev-list": { code: 0, stdout: "5\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toStrictEqual("NeedsFactoring");
    const resultNF = result as Extract<typeof result, { _tag: "NeedsFactoring" }>;
    expect(resultNF.commitCount).toStrictEqual(5);
  });
});

// ---------------------------------------------------------------------------
// checkAtomicity — Atomic
// ---------------------------------------------------------------------------

describe("checkAtomicity — Atomic", () => {
  it("returns Atomic when commit count is 1", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "rev-list": { code: 0, stdout: "1\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toStrictEqual("Atomic");
    const resultAtomic = result as Extract<typeof result, { _tag: "Atomic" }>;
    expect(resultAtomic.headSHA).toStrictEqual(sha1);
  });

  it("returns Atomic when commit count is 0", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "rev-list": { code: 0, stdout: "0\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toStrictEqual("Atomic");
  });

  it("returns Indeterminate when rev-list output is not a number (no longer silently treats as Atomic)", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "rev-list": { code: 0, stdout: "not-a-number\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toStrictEqual("Indeterminate");
  });

  it("uses lastCleanSHA as base when provided (skips merge-base)", async () => {
    const calls: ExecCall[] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push({ cmd: _cmd, args });
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "rev-list": { code: 0, stdout: "1\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    await checkAtomicity(exec, Option.some(sha2));
    const mergeBaseCalls = calls.filter((c) => c.args[0] === "merge-base");
    expect(mergeBaseCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkAtomicity — NeedsFactoring
// ---------------------------------------------------------------------------

describe("checkAtomicity — NeedsFactoring", () => {
  it("returns NeedsFactoring when commit count is 2", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "rev-list": { code: 0, stdout: "2\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toStrictEqual("NeedsFactoring");
    const resultNF = result as Extract<typeof result, { _tag: "NeedsFactoring" }>;
    expect(resultNF.headSHA).toStrictEqual(sha1);
    expect(resultNF.baseSHA).toStrictEqual(sha2);
    expect(resultNF.commitCount).toStrictEqual(2);
  });

  it("returns NeedsFactoring when commit count is 10", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "rev-list": { code: 0, stdout: "10\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toStrictEqual("NeedsFactoring");
    const resultNF = result as Extract<typeof result, { _tag: "NeedsFactoring" }>;
    expect(resultNF.commitCount).toStrictEqual(10);
  });

  it("uses default branch merge-base when no lastCleanSHA", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "merge-base": { code: 0, stdout: sha2 + "\n", stderr: "" },
        "rev-list": { code: 0, stdout: "3\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toStrictEqual("NeedsFactoring");
    const resultNF = result as Extract<typeof result, { _tag: "NeedsFactoring" }>;
    expect(resultNF.commitCount).toStrictEqual(3);
  });

  it("calls rev-list with correct SHA range", async () => {
    const calls: ExecCall[] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push({ cmd: _cmd, args });
      const dispatch: Record<string, { code: number; stdout: string; stderr: string }> = {
        "rev-parse": { code: 0, stdout: sha1 + "\n", stderr: "" },
        "rev-list": { code: 0, stdout: "5\n", stderr: "" },
      };
      const key = args[0] ?? "";
      return dispatch[key] ?? { code: 1, stdout: "", stderr: "" };
    };
    await checkAtomicity(exec, Option.some(sha2));
    const revListCall = calls.find((c) => c.args[0] === "rev-list");
    expect(revListCall).toBeDefined();
    expect(revListCall!.args).toStrictEqual(["rev-list", "--count", `${String(sha2)}..HEAD`]);
  });
});

// ---------------------------------------------------------------------------
// buildFactorMessage
// ---------------------------------------------------------------------------

describe("buildFactorMessage", () => {
  it("emits no --exec flags when gate list is empty", () => {
    const msg = buildFactorMessage(sha1, sha2, []);

    expect(msg).toContain("Use `` as the validation gates");
    // The only `--exec` reference left should be the prose that tells
    // the agent how to pass the flags (mentioned once, verbatim).
    const execMatches = msg.match(/--exec/g) ?? [];
    expect(execMatches).toHaveLength(1);
  });

  it("emits a single --exec flag for a single gate command", () => {
    const msg = buildFactorMessage(sha1, sha2, [cmd("npm test")]);

    expect(msg).toContain("--exec 'npm test'");
    expect(msg).not.toContain("&&");
  });

  it("emits one --exec flag per gate command", () => {
    const msg = buildFactorMessage(sha1, sha2, [cmd("npm test"), cmd("npm run lint")]);

    expect(msg).toContain("--exec 'npm test' --exec 'npm run lint'");
    expect(msg).not.toContain("&&");
  });

  it("shell-quotes gate commands containing single quotes", () => {
    // If a gate command contains a single quote, the previous naive
    // '${cmd}' interpolation produced a broken shell snippet. Verify
    // that single quotes are properly escaped using the '\''  pattern.
    const msg = buildFactorMessage(sha1, sha2, [cmd("bash -c 'echo hi'")]);

    expect(msg).toContain("--exec 'bash -c '\\''echo hi'\\'''");
  });
});

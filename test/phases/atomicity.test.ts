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
    const result = map[key];
    if (result) return { code: result.code, stdout: result.stdout, stderr: "" };
    return { code: 1, stdout: "", stderr: "no match" };
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
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toBe(sha1);
    }
  });

  it("falls back to master when main does not exist", async () => {
    const exec = makeExecMap({
      "merge-base HEAD master": { code: 0, stdout: sha2 + "\n" },
    });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toBe(sha2);
    }
  });

  it("falls back to develop when main and master do not exist", async () => {
    const exec = makeExecMap({
      "merge-base HEAD develop": { code: 0, stdout: sha3 + "\n" },
    });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toBe(sha3);
    }
  });

  it("returns None when no default branches exist", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "not found" });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isNone(result)).toBe(true);
  });

  it("prefers main over master (returns main when both exist)", async () => {
    const exec = makeExecMap({
      "merge-base HEAD main": { code: 0, stdout: sha1 + "\n" },
      "merge-base HEAD master": { code: 0, stdout: sha2 + "\n" },
    });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toBe(sha1);
    }
  });

  it("prefers master over develop (returns master when main absent)", async () => {
    const exec = makeExecMap({
      "merge-base HEAD master": { code: 0, stdout: sha2 + "\n" },
      "merge-base HEAD develop": { code: 0, stdout: sha3 + "\n" },
    });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toBe(sha2);
    }
  });

  it("returns None when merge-base returns invalid SHA", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "not-a-sha\n", stderr: "" });
    const result = await getDefaultBaseSHA(exec);
    expect(Option.isNone(result)).toBe(true);
  });

  it("calls git merge-base HEAD <branch>", async () => {
    const calls: ExecCall[] = [];
    const trackingExec: ExecFn = async (command, args) => {
      calls.push({ cmd: command, args });
      return { code: 1, stdout: "", stderr: "" };
    };

    await getDefaultBaseSHA(trackingExec);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.cmd).toBe("git");
    expect(calls[0]!.args[0]).toBe("merge-base");
    expect(calls[0]!.args[1]).toBe("HEAD");
  });
});

// ---------------------------------------------------------------------------
// checkAtomicity — Indeterminate (HEAD not resolved)
// ---------------------------------------------------------------------------

describe("checkAtomicity — Indeterminate", () => {
  it("returns Indeterminate when rev-parse HEAD fails", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "fatal" });
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toBe("Indeterminate");
  });

  it("returns Indeterminate when HEAD SHA is invalid", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "not-a-sha\n", stderr: "" });
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toBe("Indeterminate");
  });

  it("returns Indeterminate when stdout is empty", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "", stderr: "" });
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toBe("Indeterminate");
  });
});

// ---------------------------------------------------------------------------
// checkAtomicity — NoBase
// ---------------------------------------------------------------------------

describe("checkAtomicity — NoBase", () => {
  it("returns NoBase when no lastCleanSHA and no default branches", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "rev-parse") {
        return { code: 0, stdout: sha1 + "\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "no branch" };
    };
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toBe("NoBase");
    if (result._tag === "NoBase") {
      expect(result.headSHA).toBe(sha1);
    }
  });

  it("returns NoBase when merge-base equals HEAD (working on default branch)", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      if (args[0] === "merge-base") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toBe("NoBase");
    if (result._tag === "NoBase") {
      expect(result.headSHA).toBe(sha1);
    }
  });
});

// ---------------------------------------------------------------------------
// checkAtomicity — Atomic
// ---------------------------------------------------------------------------

describe("checkAtomicity — Atomic", () => {
  it("returns Atomic when commit count is 1", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: "1\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toBe("Atomic");
    if (result._tag === "Atomic") {
      expect(result.headSHA).toBe(sha1);
    }
  });

  it("returns Atomic when commit count is 0", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: "0\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toBe("Atomic");
  });

  it("returns Atomic when rev-list output is not a number", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: "not-a-number\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toBe("Atomic");
  });

  it("uses lastCleanSHA as base when provided (skips merge-base)", async () => {
    const calls: ExecCall[] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push({ cmd: _cmd, args });
      if (args[0] === "rev-parse") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: "1\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
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
      if (args[0] === "rev-parse") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: "2\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toBe("NeedsFactoring");
    if (result._tag === "NeedsFactoring") {
      expect(result.headSHA).toBe(sha1);
      expect(result.baseSHA).toBe(sha2);
      expect(result.commitCount).toBe(2);
    }
  });

  it("returns NeedsFactoring when commit count is 10", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: "10\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.some(sha2));
    expect(result._tag).toBe("NeedsFactoring");
    if (result._tag === "NeedsFactoring") {
      expect(result.commitCount).toBe(10);
    }
  });

  it("uses default branch merge-base when no lastCleanSHA", async () => {
    const exec: ExecFn = async (_cmd, args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      if (args[0] === "merge-base") return { code: 0, stdout: sha2 + "\n", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: "3\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const result = await checkAtomicity(exec, Option.none());
    expect(result._tag).toBe("NeedsFactoring");
    if (result._tag === "NeedsFactoring") {
      expect(result.commitCount).toBe(3);
    }
  });

  it("calls rev-list with correct SHA range", async () => {
    const calls: ExecCall[] = [];
    const exec: ExecFn = async (_cmd, args) => {
      calls.push({ cmd: _cmd, args });
      if (args[0] === "rev-parse") return { code: 0, stdout: sha1 + "\n", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: "5\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };
    await checkAtomicity(exec, Option.some(sha2));
    const revListCall = calls.find((c) => c.args[0] === "rev-list");
    expect(revListCall).toBeDefined();
    expect(revListCall!.args).toContain("--count");
    expect(revListCall!.args.some((a) => a.includes("..HEAD"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildFactorMessage
// ---------------------------------------------------------------------------

describe("buildFactorMessage", () => {
  it("includes shortened base and head SHAs", () => {
    const msg = buildFactorMessage(sha1, sha2, []);
    // sha1 = "a".repeat(40), first 8 chars = "aaaaaaaa"
    expect(msg).toContain("aaaaaaaa");
    // sha2 = "b".repeat(40), first 8 chars = "bbbbbbbb"
    expect(msg).toContain("bbbbbbbb");
  });

  it("includes the commit range in backtick format", () => {
    const msg = buildFactorMessage(sha1, sha2, []);
    expect(msg).toContain("`aaaaaaaa..bbbbbbbb`");
  });

  it("includes a single gate command in --exec flag", () => {
    const msg = buildFactorMessage(sha1, sha2, [cmd("npm test")]);
    expect(msg).toContain("--exec");
    expect(msg).toContain("npm test");
  });

  it("joins multiple gate commands with &&", () => {
    const msg = buildFactorMessage(sha1, sha2, [cmd("npm test"), cmd("npm run lint")]);
    expect(msg).toContain("npm test && npm run lint");
  });

  it("includes git-factor skill reference", () => {
    const msg = buildFactorMessage(sha1, sha2, []);
    expect(msg.toLowerCase()).toContain("git-factor");
  });

  it("mentions atomic commits", () => {
    const msg = buildFactorMessage(sha1, sha2, []);
    expect(msg.toLowerCase()).toContain("atomic");
  });

  it("works with no gate commands (empty exec)", () => {
    const msg = buildFactorMessage(sha1, sha2, []);
    expect(msg).toContain("--exec");
    // empty join produces "--exec ''"
    expect(msg).toContain("''");
  });

  it("mentions all gates pass", () => {
    const msg = buildFactorMessage(sha1, sha2, []);
    expect(msg.toLowerCase()).toContain("gates pass");
  });

  it("asks for confirmation after factoring", () => {
    const msg = buildFactorMessage(sha1, sha2, []);
    expect(msg.toLowerCase()).toContain("confirm");
  });

  it("returns a multi-line string", () => {
    const msg = buildFactorMessage(sha1, sha2, []);
    expect(msg.split("\n").length).toBeGreaterThan(1);
  });

  it("three gate commands joined correctly", () => {
    const msg = buildFactorMessage(sha1, sha2, [
      cmd("npm test"),
      cmd("npm run lint"),
      cmd("npm run build"),
    ]);
    expect(msg).toContain("npm test && npm run lint && npm run build");
  });
});

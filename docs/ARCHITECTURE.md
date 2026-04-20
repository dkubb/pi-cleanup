# Architecture

## Overview

This is a pi extension that hooks into the `agent_end` event to
ensure the repository is clean and well-structured after each
agent interaction. It runs quality gates, asks the agent to
commit uncommitted work, asks the agent to delegate a holistic
code review to a subagent, asks the agent to split non-atomic
commits via the git-factor skill, asks the agent to verify the
original task is complete, and then collapses the cleanup
context via `navigateTree` to save tokens.

## Hook Point: `agent_end`

The extension uses the `agent_end` event, not `turn_end`.

`turn_end` fires inside the agent loop after each assistant
response + tool execution. It fires on every intermediate turn.
`agent_end` fires once after the agent loop fully exhausts all
tool calls, steering messages, and follow-up messages.

When the handler needs the agent to do more work, it calls
`pi.sendUserMessage(text)` with no `deliverAs` option. Since the
agent is idle at `agent_end`, this starts a new agent run. When
that run completes, `agent_end` fires again, and the handler
re-enters the pipeline (respecting the current cycle position).

The handler has two delivery cases:

- **Fix-message dispatches** (gate fix, dirty tree, review,
  factor, eval first pass) call `pi.sendUserMessage(text)` and
  do **not** await. Since pi is idle at `agent_end`, this starts
  a new agent run. The extension handler returns immediately so
  the runner can drain, and that new run's `agent_end` drives
  pipeline re-entry.
- **Terminal collapse** is different. The second pass of
  `runEvalOrComplete` awaits `collapseIfNeeded(runtime)`
  directly. `navigateTree` must complete before the handler
  resolves; otherwise later pipeline entries could observe a
  mixed visible state.

The collapse path used to route through an LLM round-trip. It
now stays inside the harness, which is more deterministic and
also a correctness fix because the slash follow-up design never
actually hit the command handler. See the Collapse section.

## Effect-TS

The project uses [Effect](https://effect.website) for:

- **`Schema`** with **`Brand`** for "Parse, Don't Validate"
  branded types. Constructors that narrow input return
  `Either<BrandedType, ParseError>`. Constructors that accept
  all valid inputs return the type directly.
- **`Data.TaggedEnum`** for discriminated unions with structural
  equality (`CleanupState`, `TransitionEvent`, phase result
  types).
- **`Match`** with **`Match.exhaustive`** for exhaustive pattern
  matching on tagged enums. The compiler rejects unhandled
  variants.
- **`Either`** as the result type for fallible operations. No
  thrown exceptions for expected failures.
- **`Option`** for values that may be absent (`lastCleanCommitSHA`,
  `gateConfig`, `collapseAnchorId`, `commandCtx`,
  `pluginVersion`).

### Parse, Don't Validate

Constructors validate at the boundary and produce branded types.
Once a value has a branded type, downstream code trusts it without
re-validation.

Constructors that narrow (reject some inputs) return
`Either<T, ParseError>` via `Schema.decodeUnknownEither`. Code
that receives an `Either` must handle the error case explicitly.

Constructors should be maximally strict — only accept data valid
in 100% of cases. It is easier to loosen a constraint later than
to tighten one.

```ts
import { Schema } from "effect";

// Narrowing constructor → returns Either
const CommitSHA = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{40}$/),
  Schema.brand("CommitSHA"),
);
type CommitSHA = typeof CommitSHA.Type;
const decodeCommitSHA = Schema.decodeUnknownEither(CommitSHA);

// Non-narrowing constructor → returns directly
// (Data.TaggedEnum constructors accept their fields and always succeed)
const idle = CleanupState.Idle();
```

Parallel branded primitives follow the same pattern:

- `CommitSHA` — pattern `/^[0-9a-f]{40}$/`, decoded via
  `decodeCommitSHA`. Boundary for git SHAs everywhere.
- `GateCommand` — trimmed non-empty string, decoded via
  `decodeGateCommand`. Boundary for `/gates` input and
  persisted entries.
- `AttemptCount` — non-negative integer, decoded via
  `decodeAttemptCount`. Used on `WaitingFor*` state variants to
  track retries.
- `CommitCount` — non-negative-integer-from-string, decoded via
  `decodeCommitCount`. Boundary for `git rev-list --count`
  output. Replaced a prior `parseInt + isNaN`
  silent-coercion site.

Note: `ExecFn` and `AppendEntryFn` are plain type aliases for
dependency injection, not branded types. They cannot be validated
at a boundary (you can't validate a function). They exist
alongside the branded types in `types.ts` for convenience.

### Parsing Numbers from Strings

When parsing a number from a string, pre-filter with a regex
before handing to Schema's `parseNumber`. The regex should
reject any format ambiguity — leading zeros, whitespace, signs,
hex/octal prefixes — so the `parseNumber` step can never see
input with multiple valid interpretations.

Reference patterns:

- Non-negative integer (allowing bare `0`, rejecting `00` /
  `007`): `/^(0|[1-9]\d*)$/`
- Non-negative decimal (allowing `0.1`, `1.1`; rejecting `01` /
  `01.1` / `.1` / `1.`):
  `/^(0|[1-9]\d*)(\.\d+)?$/`

Regex-first rejection eliminates the old `parseInt(..., 10)`
radix-ambiguity dance: if the regex never lets an ambiguous
string through, base-10 parsing is both implicit and
unambiguous. `CommitCount` uses `/^(0|[1-9]\d*)$/` so
leading-zero forms (`00`, `007`, `01`) are rejected at the
regex boundary while bare `0` is still accepted. Regression
tests in `test/types.test.ts` pin the three rejection cases.

### Tagged Enums

All discriminated unions use `Data.TaggedEnum`. This provides:

- A `_tag` discriminant field
- Structural equality
- Constructor functions per variant
- Compatibility with `Match.exhaustive`

```ts
import { Data, Match } from "effect";

type CleanupState = Data.TaggedEnum<{
  Idle: {};
  WaitingForTreeFix: { readonly attempts: AttemptCount };
  Disabled: {};
}>;
const CleanupState = Data.taggedEnum<CleanupState>();

// Exhaustive match — compile error if variant missing
const label = Match.type<CleanupState>().pipe(
  Match.tag("Idle", () => "idle"),
  Match.tag("WaitingForTreeFix", (s) => `attempt ${s.attempts}`),
  Match.tag("Disabled", () => "off"),
  Match.exhaustive,
);
```

### Phase Result Types

Phase functions return `Data.TaggedEnum` result types wrapped
in `Promise`:

```ts
type GitStatusResult = Data.TaggedEnum<{
  Clean: {};
  Dirty: { readonly porcelain: string };
  NotARepo: {};
}>;

function checkGitStatus(exec: ExecFn): Promise<GitStatusResult>;
```

That same philosophy extends to the runner return types in the
pipeline orchestrator. The orchestrator consumes explicit
variants, not fused booleans.

### Tagged Enum Inventory

| Category | Type | Purpose + variants |
| --- | --- | --- |
| State machine | `CleanupState` | Resting cleanup state across agent runs. Variants: `Idle`, `WaitingForTreeFix`, `WaitingForGateFix`, `WaitingForFactoring`, `AwaitingUserInput`, `Disabled`. |
| State machine | `AwaitingReason` | Why `AwaitingUserInput` is blocked. Variants: `GatesUnconfigured`, `Stalled`. |
| State machine | `TransitionEvent` | Inputs that drive state transitions. Variants: `GitDirty`, `GitClean`, `NotARepo`, `GateFailed`, `GatesPassed`, `NoGateConfig`, `NeedsFactoring`, `FactoringConverged`, `Atomic`, `NoBase`, `Indeterminate`, `MaxAttemptsExceeded`, `UserEnabled`, `UserDisabled`, `UserResumed`, `GatesConfigured`, `SessionStarted`. |
| Phase outcomes | `ReviewPhaseOutcome` | Review runner outcome. Variants: `Requested`, `Completed`, `Skipped`. |
| Phase outcomes | `ReviewSkipReason` | Why review skipped this cycle. Variants: `AlreadyComplete`, `HeadUnavailable`, `BaseUnavailable`, `CommitCountUnavailable`, `EmptyRange`. |
| Phase outcomes | `AtomicityPhaseOutcome` | Atomicity runner outcome. Variants: `FactoringRequested`, `Atomic`, `NoBase`, `Indeterminate`. |
| Phase outcomes | `DirtyTreePhaseOutcome` | Dirty-tree runner outcome. Variants: `CommitRequested`, `NotARepo`, `Clean`. |
| Phase intermediate results | `GitStatusResult` | Raw git-status observation. Variants: `Clean`, `Dirty`, `NotARepo`. |
| Phase intermediate results | `GateResult` | Gate execution result. Variants: `AllPassed`, `Failed`. |
| Phase intermediate results | `AtomicityResult` | Commit-range classification inside atomicity checking. Variants: `Atomic`, `NoBase`, `Indeterminate`, `NeedsFactoring`. |
| Boundary errors | `GateConfigRestoreError` | Gate-entry restore failures. Variants: `NotARecord`, `Tombstone`, `CommandsNotArray`, `CommandsEmpty`, `InvalidCommand`. |
| Boundary errors | `CommitSHARestoreError` | Commit-entry restore failures. Variants: `NotAString`, `InvalidSHA`. |
| Boundary errors | `ParseGateInputError` | `/gates` input parsing failures. Variants: `Empty`, `InvalidCommand`. |
| Handler skip | `SkipReason` | Why `agent_end` skipped the pipeline. Variants: `NotActionable`, `CycleComplete`, `NoMutation`. |

Every distinct outcome gets its own variant; no
`true`/`false`/`null`/`undefined` hides multiple meanings behind a
single value.

## Pipeline

The pipeline runs on every `agent_end` that is not skipped, in
fixed order:

1. **Gate phase** — executes the configured gate commands (e.g.
   formatter, linter, tests) via `bash -c`. On first failure,
   sends a fix message and returns. If no gates are configured,
   transitions to `AwaitingUserInput(GatesUnconfigured)`.
2. **Dirty tree phase** — runs `git status --porcelain=v1`. If
   dirty, sends a commit message request and returns. If not in
   a git repo, the whole git-dependent section is skipped.
3. **Review phase** — if there are commits between `baseSHA` and
   HEAD (and review has not already completed this cycle), asks
   the agent to delegate a holistic code review to a subagent,
   passing a `git show` (single commit) or `git log --patch`
   (range) command for the reviewer to load.
4. **Atomicity phase** — compares HEAD against a base SHA
   resolved with a three-level fallback (`lastCleanCommitSHA`
   → merge-base with `main`/`master`/`develop` → empty-tree
   SHA). If more than one commit separates them, sends a
   factor message referencing the git-factor skill with the
   configured gate commands as `--exec`. See Atomicity Scope
   below for the full fallback rationale.
5. **Eval phase** — once everything passes, prompts the agent
   to verify the original task is actually complete. First pass
   sends the eval prompt; second pass marks the cycle done.
6. **Collapse** — the second eval pass awaits
   `collapseIfNeeded(runtime)` directly, which uses the stored
   `commandCtx` bridge to call `navigateTree` and summarize the
   cleanup turns.

The top-level orchestrator is `handleAgentEnd` in
`src/pipeline.ts`. Phase runners are split across small
single-responsibility modules: `src/pipeline-phases.ts` (gate
and dirty-tree and atomicity runners), `src/pipeline-review.ts`
(review runner + commit count), `src/pipeline-collapse.ts`
(anchor capture + collapse), `src/pipeline-skip.ts`
(skip-reason decision), and `src/pipeline-record.ts`
(prior-cycle completion observation).

Each phase runner returns a tagged value that preserves the
reason for the outcome:

- `runGatePhase` returns `Option<GateConfig>`: `None` means the
  phase handled it (no gate configured → dispatched
  `NoGateConfig`, or a gate failed → dispatched `GateFailed` +
  nudge). `Some(config)` means gates passed — caller continues
  with the unwrapped config.
- `runDirtyTreePhase` returns `DirtyTreePhaseOutcome`:
  `CommitRequested({ porcelain })` / `NotARepo` / `Clean`.
  Caller matches via `Match.value(...).pipe(Match.tag(...),
  Match.exhaustive)`.
- `runReviewIfNeeded` returns `ReviewPhaseOutcome`:
  `Requested` / `Completed` / `Skipped({ reason:
  ReviewSkipReason })`. Only `Requested` short-circuits the
  pipeline; `Completed` and `Skipped` continue to atomicity.
- `runAtomicityPhase` returns `AtomicityPhaseOutcome`:
  `FactoringRequested` / `Atomic` / `NoBase` /
  `Indeterminate`. Only `FactoringRequested` short-circuits.

Why this shape: fused booleans lose information; distinct
variants let callers act on each case explicitly. See the
existing "Phase Result Types" subsection above — the same
philosophy that uses tagged enums for `GitStatusResult` extends
to runner return types.

Eval and collapse live in `runEvalOrComplete`, which has no
return value — it is the terminal phase and always owns the
cycle's exit path.

## Cleanup Cycle

A **cleanup cycle** is the arc of work from the first mutation
after the last clean state through to the collapse. A cycle
spans multiple `agent_end` invocations — one per agent response
plus each extension-injected continuation.

The cycle state lives on the `RuntimeState` (see `src/runtime.ts`):

- `mutationDetected` — set by the `tool_call` listener whenever
  a tool in `FILE_MUTATING_TOOLS` runs. The pipeline skips
  entirely if no mutation has occurred since the last completed
  cycle and nothing is mid-cycle.
- `reviewPending`, `reviewComplete` — review is a two-pass
  phase. First pass sets `reviewPending = true` and sends the
  review request; on re-entry, `reviewPending` is cleared and
  `reviewComplete` is set so review does not repeat.
- `evalPending`, `cycleComplete` — eval is also two-pass. First
  pass sends the eval prompt. Second pass marks the cycle
  complete and calls collapse directly.
- `cycleActions` — list of human-readable descriptions of what
  this cycle did. Passed to `navigateTree` as custom
  instructions so the collapse summary reflects the work.
- `collapseAnchorId` — leaf entry ID captured at the pre-user-
  prompt boundary. The `input` handler stores the current leaf
  before the next user prompt enters the tree, so collapse can
  fold the entire cycle — user prompt, agent work, extension
  nudges, and follow-up responses — into one summary.
- `commandCtx` — stored `navigateTree` binding captured when the
  `/cleanup` or `/gates` command last ran. Needed because
  `navigateTree` is only exposed via `ExtensionCommandContext`,
  not the `ExtensionContext` passed to event handlers. Written
  on every command invocation via the shared `storeCommandCtx`
  helper; `handleCleanupCollapse` additionally re-stores it on
  entry so a manual `/cleanup collapse` always uses the
  freshest binding. The pipeline's direct `collapseIfNeeded`
  call reads whichever binding was last written.

### Skip Logic

`handleAgentEnd` bails early when any of the following are true:

- `!isActionable(cleanup)` — state is `Disabled` or
  `AwaitingUserInput`.
- `cycleComplete` — the cycle is already finished; wait for the
  next user-initiated input to reset.
- `!mutationDetected && !isCycleInProgress(runtime)` — nothing
  has changed and we are not mid-cycle, so there is no work.

If the state is actionable, the handler next checks
`isGitUnchanged` (HEAD matches `lastCleanCommitSHA` and the
working tree is clean). When that is true and we are not
mid-cycle, it clears `mutationDetected` and returns without
running phases.

### Cycle Reset

The `input` listener watches for non-extension prompts. It
always re-captures the collapse anchor for the next user-
initiated task by clearing `collapseAnchorId` and recording the
current leaf ID again.

When a new user-sourced prompt arrives with
`cycleComplete === true`, the same handler also clears
`cycleComplete`, `evalPending`, `reviewPending`,
`reviewComplete`, and `cycleActions` — opening a fresh cycle for
the new prompt.

Extension-injected `sendUserMessage` calls have
`event.source === "extension"` and do not reset the cycle or
re-capture the user-boundary anchor.

## Commands

The extension registers two slash-command families.

- `/gates` (no args) — opens the editor modal to configure
  gates; primarily a TUI path. Lets the user enter one command
  per line.
- `/gates show` — notifies the current gate configuration, or
  `No gates configured.`
- `/gates clear` — clears gates (writes a tombstone entry so the
  clear survives session reload).
- `/gates configure <commands>` — non-interactive form. Single
  line: `/gates configure just check`. Multi-line: embedded
  literal newlines, one command per line. Empty arg → usage
  hint, does not clear existing config. Invalid line → error
  notification, existing config untouched. Bypasses the editor
  — intended for RPC drivers and headless automation that
  cannot respond to editor prompts. Side effects identical to
  the editor path.
- `/cleanup on` / `off` / `resume` — state-machine transitions
  (`UserEnabled` / `UserDisabled` / `UserResumed`).
- `/cleanup status` — notifies
  `State: <tag>\nGates: <N-or-none>\nLast clean: <sha-or-none>\nVersion: <short-sha-or-unknown>`.
- `/cleanup collapse` — manual collapse trigger; calls
  `collapseIfNeeded`. Rarely needed — the pipeline runs this
  automatically at end-of-cycle.
- `/cleanup reload` — warm-reload the extension.
  - The handler notifies `Reloading extension. A follow-up
    /cleanup status will report the loaded version.`, queues
    `pi.sendUserMessage("/cleanup status", { deliverAs:
    "followUp" })`, then awaits `ctx.reload()`.
  - `AgentSession.reload()` re-runs the extension files from
    disk, fires `session_shutdown` then `session_start` with
    `reason: "reload"`, and preserves the conversation tree.
  - It re-initializes the runtime via `resetRuntimeState`,
    which clears `pluginVersion` to `None` along with the other
    runtime fields.
  - After that reset, the `session_start` handler runs
    `capturePluginVersion` to populate `pluginVersion` from a
    fresh `git rev-parse --short HEAD`.
  - After reload completes, pi processes the follow-up queue;
    the queued `/cleanup status` runs under the post-reload
    code and reports the freshly captured `pluginVersion` to
    the user automatically.
  - This is the one place the extension still dispatches
    slash-like text through `sendUserMessage`. It works because
    pi drains the follow-up queue through the command-dispatch
    path rather than through `prompt()` with
    `expandPromptTemplates: false`; if that internal routing
    changes, the post-reload status announcement stops working.

## State Machine

The cleanup process is a finite state machine. Only "resting"
states (those that persist between agent runs) are modeled.
Transient evaluation (running `git status`, executing gates)
happens procedurally within the handler and does not need its
own state.

The resting states track *why* a cycle is waiting on the agent.
Review/eval bookkeeping lives on the `RuntimeState` (flags),
not in the state machine, because those phases always route
through `Idle`-like handler entry: they do not need their own
waiting variants.

### States

```text
┌────────┐  agent_end   ┌──────────────────────────┐
│  Idle  │─────────────►│ run pipeline:            │
└────────┘              │ gates → dirty → review → │
    ▲                   │ atomicity → eval         │
    │                   └────────┬─────────────────┘
    │                       sends fix message
    │                            │
    │   ┌────────────────────────┼────────────────────┐
    │   │                        │                    │
    │   ▼                        ▼                    ▼
    │ ┌──────────────┐  ┌───────────────┐  ┌────────────────┐
    │ │WaitingFor    │  │WaitingFor     │  │WaitingFor      │
    │ │TreeFix       │  │GateFix        │  │Factoring       │
    │ └──────────────┘  └───────────────┘  └────────────────┘
    │   │                        │                    │
    │   └────────────────────────┼────────────────────┘
    │                   agent_end (re-evaluate)
    │                            │
    │                       all pass
    │                            │
    │         (state is already Idle via Atomic/NoBase);
    │              eval + collapse run on top of Idle
    │                            │
    └────────────────────────────┘

Special states:
┌────────────────────┐    ┌──────────┐
│AwaitingUserInput   │    │ Disabled │
└────────────────────┘    └──────────┘
```

### Resting States

| State | Meaning | Re-enters handler? |
| --- | --- | --- |
| `Idle` | Not waiting on a gate/tree/factor fix (review and eval may still be mid-cycle — tracked on `RuntimeState`) | Yes |
| `WaitingForTreeFix` | Sent message to commit dirty files | Yes |
| `WaitingForGateFix` | Sent message to fix a gate failure | Yes |
| `WaitingForFactoring` | Sent message to factor commits | Yes |
| `AwaitingUserInput` | Blocked on user action. The payload distinguishes `GatesUnconfigured` from `Stalled({ phase, attempts })`. | No |
| `Disabled` | Extension turned off | No |

### Awaiting Reasons

`AwaitingUserInput` carries a tagged payload so the block reason is
explicit:

- `GatesUnconfigured` — no gate config at `session_start`; user
  runs `/gates` or `/gates configure` to unblock.
- `Stalled({ phase, attempts })` — `MaxAttemptsExceeded` fired
  during `phase` (one of the three `WaitingFor*` variants);
  user runs `/cleanup resume` to retry.

The user-paused path is modeled separately as the `Disabled`
resting state, not as an `AwaitingReason` variant: user runs
`/cleanup off`; user runs `/cleanup on` to re-enable.

### Gate Configuration Is Required

When no gates are configured, the handler transitions to
`AwaitingUserInput(GatesUnconfigured)` rather than silently
skipping. Skipping gates would make the `GatesUnconfigured`
path unreachable and would require a separate `GatesSkipped`
state to correctly model the pipeline. Requiring explicit
configuration ensures the user makes a deliberate choice about
what quality checks to run.

### Gate Side-Effect Convention

Gate commands should be side-effect-free, or — if a gate
writes to tracked files (coverage ratchets, lockfiles, generated
configs, etc.) — the gate must stage those writes with `git add`
before it exits. If a gate leaves the tree dirty, the pipeline
sees "dirty tree after gate passed" and re-enters
`WaitingForTreeFix`, which can loop indefinitely in pathological
cases.

Example: this project's `just test` recipe runs
`vitest run --coverage` with `autoUpdate: true`, then
`git add vitest.config.ts` so any coverage-threshold update is
part of the same cycle's work rather than a new dirty-tree
observation.

### Handler Entry Logic

`handleAgentEnd` runs when `isActionable(state)` returns `true`
(`Idle`, `WaitingForTreeFix`, `WaitingForGateFix`,
`WaitingForFactoring`) and the skip checks above do not fire.

On entry it runs in order:

1. Skip checks — `skipReason` returns early if
   `Disabled`/`AwaitingUserInput`, `cycleComplete` is true, or
   mutation state indicates no work. Plus the
   `Idle + isGitUnchanged + !mid-cycle` early return.
2. Record prior cycle completion — observes whether the last
   `WaitingFor*` request was honored (tree now clean, gate now
   passing, or HEAD moved to an atomic range) and pushes to
   `cycleActions`. Centralized here because a later phase can
   dispatch a fresh failure before its own success branch runs,
   so we observe first.
3. Check max attempts — stalls to
   `AwaitingUserInput(Stalled)` only when no progress was
   observed in step 2 — progress resets the stall pressure even
   before the phase-level state transition fires.
4. Convergence check — for `WaitingForFactoring`, dispatches
   `FactoringConverged` and persists the SHA when HEAD is
   unchanged since the factoring request. Does not short-
   circuit; falls through to subsequent phases.
5. Gate phase.
6. Git phases (dirty tree → review → atomicity) — the whole
   section skipped if `isGitRepo` returns false.
7. Eval / collapse.

Any phase that needs agent action sends a message and returns.
Pipeline re-entry is driven by the agent's next `agent_end`.

### Atomicity Scope

Base-SHA resolution for the atomicity check is a three-level
fallback in `checkAtomicity` (via its internal `resolveBaseSHA`):

1. `lastCleanCommitSHA` (session-scoped) if present — the exact
   boundary of agent-produced work in this session.
2. Otherwise, merge-base with `main`/`master`/`develop`
   (repo-scoped) — handles first-run and cross-session cases
   where no prior clean SHA exists.
3. Otherwise, the empty-tree SHA — ensures a freshly-initialized
   repo with no default branch still has a concrete base.

The `isGitUnchanged` / `resolveBaseSHA` used for the shared
`baseSHA` passed to the review phase uses the first two levels
only (see `src/phases/git-status.ts`). The empty-tree fallback
is specific to atomicity.

On `session_start`, if no `lastCleanCommitSHA` was restored, the
handler captures the current `HEAD` as the initial base. That
way the first cycle in a session has a concrete range to review
and atomize.

Because of the empty-tree fallback, `resolveBaseSHA` inside
`checkAtomicity` never returns `None` in practice. The `NoBase`
result is instead emitted when the resolved base equals HEAD —
i.e. the commit range is empty and cannot detect non-atomic
commits. The handler treats this as a success, persists HEAD,
and transitions to `Idle`.

When HEAD itself cannot be parsed (`Indeterminate`), the handler
skips the atomicity check entirely without persisting anything.
We cannot reason about commit structure without a valid HEAD, so
we step aside rather than fabricate data or block the user.

### Convergence Detection

When re-entering from `WaitingForFactoring`, the handler first
checks if HEAD matches `priorHeadSHA`. If unchanged, factoring
has converged — the agent decided no further splitting was
needed — and dispatches `FactoringConverged`, persists the SHA,
and continues through the remaining phases so eval can still
fire.

After convergence, the handler continues through gates, git
phases, and eval — it does not short-circuit — so the terminal
eval-and-collapse pass still runs. This ordering guarantees
every `agent_end` that reaches the atomicity checkpoint also
reaches collapse, keeping context reset deterministic.

### Attempt Limiting

The attempt counter lives on each `WaitingFor*` variant. The
transition function increments it whenever any failure event
(`GitDirty`, `GateFailed`, or `NeedsFactoring`) fires while
already in a waiting state — including cross-kind transitions
such as `WaitingForTreeFix → GateFailed` (which moves to
`WaitingForGateFix` with the incremented count). Only success
events (`GitClean`, `GatesPassed`, `Atomic`,
`FactoringConverged`, `NoBase`, `Indeterminate`, `NotARepo`)
transition to `Idle` without touching the counter, so the next
cycle starts fresh at 1.

Once the counter reaches `MAX_ATTEMPTS` (default 5),
`checkMaxAttempts` in the orchestrator dispatches
`MaxAttemptsExceeded`, which transitions to
`AwaitingUserInput(Stalled)` and notifies the user.

### Transition Events

State transitions are driven by a `TransitionEvent` tagged enum.
The `transition` function takes `(state, event)` and returns the
new state.

The outer match on `state._tag` uses `Match.exhaustive` (every
state must be handled). For actionable states (`Idle` and the
`WaitingFor*` variants), the inner match on `event._tag` also
uses `Match.exhaustive` — adding a new event without handling
it here produces a compile error. Non-actionable states
(`AwaitingUserInput`, `Disabled`) also use `Match.exhaustive`.
Each pipeline event is listed with an explicit no-op branch that
returns the current state unchanged, so a new `TransitionEvent`
variant produces a compile error at every state site. The
alternative — `Match.orElse(() => state)` — would have been
terser but would let new events slip past silently; the code
deliberately chose per-site exhaustiveness over brevity.

Events fall into two categories:

- **Pipeline events** — emitted by the handler during
  evaluation:
  - `GitDirty`, `NotARepo` (from `runDirtyTreePhase`)
  - `GateFailed`, `NoGateConfig` (from `runGatePhase`)
  - `NeedsFactoring`, `Atomic`, `NoBase`, `Indeterminate` (from
    `runAtomicityPhase`)
  - `FactoringConverged` (from `checkConvergence`)
  - `MaxAttemptsExceeded` (from `checkMaxAttempts`)
- **Command events**: `UserEnabled`, `UserDisabled`,
  `UserResumed`, `GatesConfigured`, `SessionStarted` — emitted
  by `/cleanup`, `/gates`, and `session_start`.

`NotARepo` is reachable even after the orchestrator's
`isGitRepo` guard: `checkGitStatus` maps any non-zero exit
from `git status` to `NotARepo`, so a mid-cycle repository
state change (or a divergence between the probe used by
`isGitRepo` and the one used by `checkGitStatus`) can still
produce it.

`GitClean` and `GatesPassed` are dispatched by the phase runners
when a prior `WaitingFor*` state observes its fix was applied —
e.g. the tree is now clean after a `WaitingForTreeFix`, or
gates now pass after a `WaitingForGateFix`. This transitions
state back to `Idle` so the rest of the pipeline can resume the
cycle.

The review and eval phases do **not** emit state machine
events. Their bookkeeping (pending/complete flags) lives on
`RuntimeState` rather than in `CleanupState`.

Non-actionable states ignore pipeline events. They only respond
to command events.

## Collapse via `navigateTree`

When a cycle completes, the pipeline calls
`collapseIfNeeded(runtime)` directly. That helper uses the
stored `commandCtx` bridge to navigate the session tree back to
an anchor captured at cycle start and summarize all the cleanup
turns in between.

### How It Works

1. **Capture anchor.** The `input` event handler in `src/index.ts`
   fires for every user-initiated prompt
   (`event.source !== "extension"`). When `cycleComplete` is
   true, the handler resets cycle flags; unconditionally it
   captures the current leaf entry ID via
   `ctx.sessionManager.getLeafId()` into
   `runtime.collapseAnchorId`. The anchor lands *before* the
   user prompt enters the session tree, so collapse folds the
   entire cycle — user prompt, agent initial work, every
   extension nudge, every response — into one summary.
2. **Store command context.** Each time the `/cleanup` or
   `/gates` command handler runs, it stores a `CommandContextRef`
   containing `navigateTree.bind(ctx)` on the runtime. This is
   the event-path ↔ command-path bridge: the event handlers
   cannot call `navigateTree` directly, so they reuse the last
   saved command binding.
3. **Direct collapse call.** `runEvalOrComplete` second pass
   awaits `collapseIfNeeded(runtime)` directly.
4. **Invoke `navigateTree`.** `collapseIfNeeded` calls
   `navigateTree(anchorId, { summarize: true,
   customInstructions })`. The custom instructions include the
   `cycleActions` list, so the summary reflects what this cycle
   did.
5. **Clear the anchor.** `collapseIfNeeded` sets
   `collapseAnchorId` back to `None` so the next cycle can
   capture a fresh anchor.

The collapse is idempotent: if either `collapseAnchorId` or
`commandCtx` is `None`, it is a no-op.

### Collapse Scope Tradeoff

**Current behavior**: the anchor lands at the pre-user-prompt
boundary. Collapse folds the entire cycle into one summary
message. Bounded 1-msg-per-cycle context growth — session
baseline stays flat across arbitrary cycle counts.

**Tradeoff**: the user's original prompt text is not preserved as
a separate visible message; it's included in what
`navigateTree` summarizes. If the eval phase's self-verification
("is there anything from the original task still pending?") is
wrong — an LLM judgment call, not deterministic — the original
prompt and partial work are lost to the summary.

**Alternative (under consideration)**: capture the anchor at the
first `agent_end` instead. That would preserve the user's prompt
along with the agent's task turn visibly, folding only the
extension-injected cleanup cycle into a summary. Higher
post-cycle baseline (20-60 msgs of initial work survive), but
original task evidence is never compressed away.

**Mechanism**: `navigateTree(anchorId, { summarize: true,
customInstructions })` does the actual collapse. We steer the
summary by passing `cycleActions` — a human-readable list of
observed outcomes (`Committed uncommitted changes` /
`Fixed failing gate` / `Delegated code review to subagent` /
`Factored commits into atomic units` / `Verified task
completion`) — as custom instructions. The extension does not
write the summary text directly; pi's summarization machinery
does, guided by the hints.

### Why a Direct Call, Not a Slash Follow-up

`pi.sendUserMessage` sets `expandPromptTemplates: false`, which
skips the slash-command dispatcher. The earlier
`sendUserMessage("/cleanup collapse", { deliverAs: "followUp" })`
design therefore never actually routed to the `/cleanup`
handler — the text was delivered to the LLM. We now route
through the `commandCtx` saved binding instead.

This moved cycle coordination from an LLM round-trip to a
harness-direct call, which is both more deterministic and a
correctness fix because the prior design was broken.

`commandCtx` is the event-path ↔ command-path bridge. The
invariant is simple: `collapseIfNeeded` is a no-op when
`commandCtx` is `None`, which is the state until the user has
invoked `/gates` or `/cleanup` at least once. On a fresh
session that starts blocked on gates, `/gates configure`
populates it as a side effect before cleanup can proceed.
Sessions that restore gates from prior entries can still reach
collapse with `commandCtx = None`; in that case collapse is
intentionally skipped until a later command invocation refreshes
the binding.

## Persisted Vs. Transient State

**Persisted** (via `pi.appendEntry`, survives session reload):

- Gate configuration (`Option<GateConfig>`)
- Last clean commit SHA (`Option<CommitSHA>`)

**Transient — reset on `session_start`** (via `resetRuntimeState`):

- `cleanup` — `CleanupState`, resets to `Idle`
- `pluginVersion` — short HEAD stamp for `/cleanup status`
- `evalPending`, `cycleComplete` — eval bookkeeping
- `reviewPending`, `reviewComplete` — review bookkeeping
- `cycleActions` — summary list for the next collapse
- `mutationDetected` — set to `true` on session start so the
  first `agent_end` runs the pipeline
- `collapseAnchorId` — leaf entry ID anchor for collapse

**Transient — not reset on `session_start`**:

- `commandCtx` — the stored `navigateTree` binding. It is
  initialized to `None` by `createInitialRuntimeState`, but
  `resetRuntimeState` does not clear it. It is refreshed every
  time the `/gates` or `/cleanup` handler runs, so a stale
  binding from a prior session gets overwritten on the first
  command invocation of the new session.

Attempt counters are embedded in the state machine variants
(`WaitingFor*.attempts`) rather than stored on the runtime.

Persistence is scoped to the pi session, not the project. This
means gate configuration must be re-entered on each new session.

**Tradeoff**: This is deliberate friction in exchange for
simplicity. Session-scoped persistence avoids cross-session
state conflicts and stale configuration. The alternative —
project-level persistence (e.g., `.pi/gates.json`) — would
require conflict resolution, migration, and a separate storage
mechanism outside the session.

**Gate clear is durable**: `/gates clear` writes a tombstone
entry (`{ cleared: true }`) using the same `ENTRY_TYPE_GATES`
key. On restore, `restoreGateConfig` treats the tombstone as a
reset to `None`, and `restoreFromEntries` iterates entries in
order so the last write wins. This ensures that gate clears
survive session reloads — the behavior is symmetric with gate
configuration.

**Mitigation**: On the first `agent_end` when no gate config is
loaded, the gate phase dispatches `NoGateConfig`, which
transitions to `AwaitingUserInput(GatesUnconfigured)` and
notifies:

```text
"No quality gates configured. Use /gates to set up."
```

This makes the friction visible and actionable rather than
silently skipping gate checks.

### Plugin Version Stamp

On `session_start`, after `resetRuntimeState`, the extension
runs `git rev-parse --short HEAD` and stores the trimmed stdout
as `runtime.pluginVersion = Option.some(sha)` on exit code 0
and non-empty output. Failure paths (not a git repo, exec
error, empty stdout) log via `warn` and leave `pluginVersion`
as `None` — `/cleanup status` then reports `Version: unknown`.
Because `/cleanup reload` triggers a fresh `session_start`, the
stamp always reflects the HEAD at the moment the extension was
loaded. Caveat: the stamp reports the *committed* HEAD —
uncommitted working-tree edits are not reflected. `Same SHA
after reload` proves the reload picked up committed changes, not
necessarily working-tree changes.

## Mutation Detection

The extension tracks "has the session mutated files since the
last clean state?" to avoid running the pipeline when the agent
only read files or answered questions.

A `tool_call` listener marks `mutationDetected = true` whenever
the agent invokes one of the tools in `FILE_MUTATING_TOOLS`
(currently `bash`, `edit`, `write`) — the only built-in pi
tools that can modify the repo. Adding a new mutating tool
means extending this set so the pipeline observes its effect.

The flag is cleared in two places:

- At the end of a successful cycle (`runEvalOrComplete` second
  pass) so the next agent turn does not trigger a duplicate
  cleanup.
- When `isGitUnchanged` proves nothing actually changed (the
  mutation tool ran but did not affect git state, e.g. a
  read-only `bash` command).

This is a conservative filter: non-mutating `bash` usage (grep,
git log, tests) can still set the flag, but the subsequent
`isGitUnchanged` check catches that case and short-circuits
the pipeline without work.

## File Structure

The pipeline orchestration is factored into several
single-responsibility modules — each concern gets its own small
file so `handleAgentEnd` stays readable and every
observation/decision is testable in isolation.

```text
src/
├── index.ts              # Extension entry, event wiring
├── commands.ts           # /gates and /cleanup command handlers
├── pipeline.ts           # agent_end orchestrator + eval phase
├── pipeline-phases.ts    # Gate, dirty-tree, atomicity runners
├── pipeline-review.ts    # Review phase runner + commit counting
├── pipeline-collapse.ts  # Anchor capture + collapseIfNeeded
├── pipeline-skip.ts      # SkipReason + isCycleInProgress
├── pipeline-record.ts    # recordPriorCycleCompletion observation
├── logger.ts             # warn(ctx, msg) helper for [pi-cleanup] prefix
├── state-machine.ts      # CleanupState, TransitionEvent, transition()
├── types.ts              # Branded primitives + GateConfig + DI aliases
├── runtime.ts            # RuntimeState shape + constructor
├── persistence.ts        # appendEntry helpers + entry type constants
├── restore.ts            # Session entry parsing helpers
├── status.ts             # Status footer indicator (updateStatus)
└── phases/
    ├── dirty-tree.ts     # Dirty tree detection + fix message
    ├── gates.ts          # Gate execution + fix message
    ├── atomicity.ts      # Atomicity check + factor message + base SHA
    ├── git-status.ts     # isGitUnchanged, resolveBaseSHA
    └── review.ts         # Review prompt construction + git command
scripts/
└── hooks/
    └── commit-msg        # Repo-local commit validator (see Tooling)
test/                     # Vitest unit tests mirroring src/
└── hooks/
    └── commit-msg.test.ts
```

## Tooling

Quality gates for this project: `just check` — oxfmt-check on
`src/**/*.ts`, rumdl check on repo-root `*.md` only, oxlint on
`src/`, `tsc --noEmit`, and `vitest run --coverage`. Auto-fix:
`just fix` — oxfmt write on `src/**/*.ts`, rumdl fmt on
repo-root `*.md`, and `oxlint --fix --fix-suggestions` on
`src/`.

Note that markdown gates only cover files at the repo root;
`docs/ARCHITECTURE.md` and any future `docs/**/*.md` files are
outside the default just recipes and must be validated
manually with `rumdl check docs/**.md`.

TypeScript at maximum strictness. oxlint with all 6 categories
at error level, 7 plugins. See `tsconfig.json` and
`.oxlintrc.jsonc`.

### Git Hooks

The repo includes a local git hook at `scripts/hooks/commit-msg`
that enforces the project's commit-message rules on every
`git commit`, regardless of which wrapper the author used. Opt
in after cloning with `just install-hooks` (which sets
`core.hooksPath` to `scripts/hooks`).

The hook enforces:

- Subject: conventional-commit format with type in the allowlist
  (`feat|fix|docs|style|refactor|perf|test|build|chore|ci|revert`),
  optional non-empty scope, optional `!` breaking-change marker,
  non-empty description, total ≤ 70 characters, first letter of
  description lowercase, no trailing period, no ` and ` or
  ` or ` connective words.
- Body: every non-comment, non-blank line ≤ 72 characters.

Subjects prefixed with `fixup!`, `squash!`, or `amend!`
followed by a space bypass subject validation entirely so
`--fixup` / `--squash` / `--amend` workflows are not blocked by
the target commit's original subject shape. Body-line length is
still enforced on autosquash commits.

Motivation: `git conventional-commit` enforces these rules when
invoked via `--action`, but automated agents frequently use raw
`git commit -m "multi-paragraph body"` which bypasses the
wrapper. The repo-local hook closes that gap universally.
Violations exit non-zero with the rule name, offending text,
and a `git conventional-commit` hint.

## Dependencies

Runtime:

- `effect` — branded types, tagged enums, exhaustive matching,
  Either, Option

Dev / peer (declared under `devDependencies`):

- `@mariozechner/pi-coding-agent` — ExtensionAPI, event types,
  command context (`navigateTree`, `sessionManager.getLeafId`)
- `@mariozechner/pi-ai` — model types
- `@sinclair/typebox` — required by pi for tool parameter
  schemas (not used directly in this extension)

### Agent-Side Requirements

The extension's phase messages reference two named skills by
string in their prose. The extension does not verify skill
availability; if the running agent does not recognize a named
skill, the phase prompt still sends, but the agent will be
unable to fulfill the instruction and the cycle will stall.

- [`git-factor`](https://github.com/dkubb/git-factor) —
  referenced by the atomicity phase to split non-atomic
  commits, passing the gate commands as `--exec`.
- `git-commit` — referenced by the review phase to validate
  commit messages.

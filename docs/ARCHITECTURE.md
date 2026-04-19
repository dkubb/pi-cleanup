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

The handler does **not** await `sendUserMessage` — it calls it
and returns, allowing the extension runner to finish. The new
agent run fires its own `agent_end` when done.

### `sendUserMessage` Does Not Route Extension Commands

`sendUserMessage` calls `prompt()` with
`expandPromptTemplates: false`, which **skips extension command
dispatch and template expansion** inside `prompt()`. The only
call site of `_tryExecuteExtensionCommand` in
`agent-session.js` is guarded by `expandPromptTemplates`, so
text starting with `/` is not dispatched to a registered
command handler via `sendUserMessage`.

This is why each fix message (gates, dirty tree, review,
factor, eval) is written as prose for the LLM, not as a slash
command — sending `/some-command` here would deliver the text
to the LLM, not invoke the command.

### Cycle Collapse Uses a `followUp` Slash Message

The one place the pipeline emits text that begins with `/` is
the terminal eval pass, which calls
`pi.sendUserMessage("/cleanup collapse",
{ deliverAs: "followUp" })`. Because this still goes through
`sendUserMessage` (with `expandPromptTemplates: false`), the
`/cleanup` handler is not invoked via the in-`prompt` command
dispatch. The text is queued as a follow-up user message; the
resulting `/cleanup collapse` invocation therefore relies on
pi-coding-agent's follow-up processing to ultimately route the
slash command. The mechanism details live outside this
extension, so this doc only describes what the extension
observably sends. See the Collapse section.

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
- **`Match.orElse`** as a catch-all for non-actionable states,
  avoiding the need to list every pipeline event explicitly for
  states that ignore them all.
- **`Either`** as the result type for fallible operations. No
  thrown exceptions for expected failures.
- **`Option`** for values that may be absent (`lastCleanCommitSHA`,
  `gateConfig`, `collapseAnchorId`, `commandCtx`).

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

Note: `ExecFn` and `AppendEntryFn` are plain type aliases for
dependency injection, not branded types. They cannot be validated
at a boundary (you can't validate a function). They exist
alongside the branded types in `types.ts` for convenience.

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

### Wildcard Matching with `Match.orElse`

For the transition function, non-actionable states (Disabled,
AwaitingUserInput) ignore most pipeline events. Rather than
listing every event explicitly, use `Match.orElse` as a catch-all:

```ts
// Handle specific events, then catch-all for the rest
const result = Match.value(event).pipe(
  Match.tag("UserEnabled", () => CleanupState.Idle()),
  Match.tag("SessionStarted", () => CleanupState.Idle()),
  Match.orElse(() => state), // All other events: no-op
);
```

This avoids the combinatorial explosion of ~6 states × ~15 events.
Use `Match.exhaustive` where every case matters (like
`isActionable`), and `Match.orElse` where most cases are no-ops.

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
6. **Collapse** — the second eval pass dispatches
   `/cleanup collapse`, which calls `commandCtx.navigateTree` to
   summarize the cleanup turns and navigate back to the anchor
   captured before the first cleanup message.

Phase runners live in `src/pipeline-phases.ts` (gates, dirty
tree, atomicity) and `src/pipeline-review.ts` (review). The
top-level orchestrator is `handleAgentEnd` in `src/pipeline.ts`.

Each phase runner returns a boolean, but the meaning varies:

- `runGatePhase`, `runDirtyTreePhase`, `runReviewIfNeeded` —
  `true` means "I handled it; caller should return early" and
  `false` means "nothing to do, continue to the next phase".
- `runAtomicityPhase` — `true` means "atomicity passed, caller
  should proceed to eval"; `false` means "I dispatched a
  factor request, caller should return early". The orchestrator
  inverts it at the call site.

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
  `bash`, `edit`, or `write` runs. The pipeline skips entirely
  if no mutation has occurred since the last completed cycle and
  nothing is mid-cycle.
- `reviewPending`, `reviewComplete` — review is a two-pass
  phase. First pass sets `reviewPending = true` and sends the
  review request; on re-entry, `reviewPending` is cleared and
  `reviewComplete` is set so review does not repeat.
- `evalPending`, `cycleComplete` — eval is also two-pass. First
  pass sends the eval prompt. Second pass marks the cycle
  complete and dispatches `/cleanup collapse`.
- `cycleActions` — list of human-readable descriptions of what
  this cycle did. Passed to `navigateTree` as custom
  instructions so the collapse summary reflects the work.
- `collapseAnchorId` — leaf entry ID captured just before the
  first cleanup `sendUserMessage` of the cycle. Set by
  `captureCollapseAnchor`.
- `commandCtx` — stored `navigateTree` binding captured when the
  `/cleanup` or `/gates` command last ran. Needed because
  `navigateTree` is only exposed via `ExtensionCommandContext`.

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

The `input` listener watches for non-extension prompts. When a
new user-sourced prompt arrives with `cycleComplete === true`,
the listener clears `cycleComplete`, `evalPending`,
`reviewPending`, `reviewComplete`, and `cycleActions` — opening
a fresh cycle for the new prompt.

Extension-injected `sendUserMessage` calls have
`event.source === "extension"` and do not reset the cycle.

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

| State                 | Meaning                                             | Re-enters handler? |
| --------------------- | --------------------------------------------------- | ------------------ |
| `Idle`                | Not waiting on a gate/tree/factor fix (review and eval may still be mid-cycle — tracked on `RuntimeState`) | Yes                |
| `WaitingForTreeFix`   | Sent message to commit dirty files                  | Yes                |
| `WaitingForGateFix`   | Sent message to fix a gate failure                  | Yes                |
| `WaitingForFactoring` | Sent message to factor commits                      | Yes                |
| `AwaitingUserInput`   | Blocked on user action                              | No                 |
| `Disabled`            | Extension turned off                                | No                 |

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

1. Skip checks (`shouldSkip`, `checkMaxAttempts`, and the
   `isGitUnchanged` early return).
2. Convergence check for `WaitingForFactoring` — if HEAD
   matches `priorHeadSHA`, dispatch `FactoringConverged`,
   persist the SHA, and return.
3. Gate phase.
4. Git-dependent phases (dirty tree → review → atomicity) —
   skipped entirely if `isGitRepo` is false.
5. Eval / collapse.

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
needed — and the handler persists the SHA and transitions to
`Idle`.

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
it here produces a compile error. For non-actionable states
(`AwaitingUserInput`, `Disabled`), the inner match uses
`Match.orElse` to return the current state for unhandled
pipeline events.

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

The `TransitionEvent` enum also defines `GitClean` and
`GatesPassed` for completeness, but the live orchestrator
never constructs them — the phase runners short-circuit on the
positive outcome instead of dispatching a "nothing went wrong"
event. Both are still handled in `transition()` (they map to
`Idle`) so the state machine remains total.

The review and eval phases do **not** emit state machine
events. Their bookkeeping (pending/complete flags) lives on
`RuntimeState` rather than in `CleanupState`.

Non-actionable states ignore pipeline events. They only respond
to command events.

## Collapse via `navigateTree`

When a cycle completes, the pipeline dispatches
`/cleanup collapse`, which navigates the session tree back to
an anchor captured at cycle start and summarizes all the
cleanup turns in between.

### How It Works

1. **Capture anchor.** Before the first `sendUserMessage` of a
   cycle (gate fix, dirty tree, review, factor, or eval),
   `captureCollapseAnchor(runtime, ctx)` records the current
   leaf entry ID via `ctx.sessionManager.getLeafId()`. It is a
   no-op if an anchor is already set, so subsequent phase
   messages do not overwrite it.
2. **Store command context.** Each time the `/cleanup` or
   `/gates` command handler runs, it stores a
   `CommandContextRef` containing `navigateTree.bind(ctx)` on
   the runtime. This is necessary because `navigateTree` is
   only exposed via `ExtensionCommandContext`, not the event
   `ExtensionContext`.
3. **Send `/cleanup collapse` as a follow-up.** The second
   pass of `runEvalOrComplete` calls
   `pi.sendUserMessage("/cleanup collapse",
   { deliverAs: "followUp" })`. This queues the text as a
   follow-up user message. Eventually the `/cleanup` handler
   runs (the exact routing is a pi-coding-agent internal
   detail, not a guarantee of `sendUserMessage` itself).
4. **Invoke `navigateTree`.** The `collapse` subcommand calls
   `collapseIfNeeded`, which calls
   `commandCtx.navigateTree(anchorId, { customInstructions,
   summarize: true })`. The custom instructions include the
   `cycleActions` list, so the summary reflects what this
   cycle did (e.g. "Fixed failing gate", "Committed uncommitted
   changes", "Factored 3 commits", "Verified task completion").
5. **Clear the anchor.** `collapseIfNeeded` sets
   `collapseAnchorId` back to `None` so the next cycle can
   capture a fresh anchor.

The collapse is idempotent: if either `collapseAnchorId` or
`commandCtx` is `None`, it is a no-op.

### Why `/cleanup collapse` Instead of a Direct Call

`navigateTree` is only available on `ExtensionCommandContext`,
not the `ExtensionContext` passed to event handlers. Routing
through a slash command gives the pipeline access to a command
context without requiring the user to type anything. The
`deliverAs: "followUp"` flag puts the message in the
follow-up queue rather than the steering queue — a queue
choice, not a command-routing guarantee.

## Persisted Vs. Transient State

**Persisted** (via `pi.appendEntry`, survives session reload):

- Gate configuration (`Option<GateConfig>`)
- Last clean commit SHA (`Option<CommitSHA>`)

**Transient — reset on `session_start`** (via `resetRuntimeState`):

- `cleanup` — `CleanupState`, resets to `Idle`
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

## Mutation Detection

The extension tracks "has the session mutated files since the
last clean state?" to avoid running the pipeline when the agent
only read files or answered questions.

A `tool_call` listener marks `mutationDetected = true` whenever
the agent invokes one of `bash`, `edit`, or `write`. These are
the only built-in tools that can modify files.

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

```text
src/
├── index.ts              # Extension entry, event wiring
├── commands.ts           # /gates and /cleanup command handlers
├── pipeline.ts           # agent_end orchestrator + eval phase
├── pipeline-phases.ts    # Gate, dirty-tree, atomicity runners + collapse
├── pipeline-review.ts    # Review phase runner + commit counting
├── state-machine.ts      # CleanupState, TransitionEvent, transition()
├── types.ts              # Branded primitives, GateConfig, DI aliases
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
test/                     # Vitest unit tests mirroring src/
```

## Tooling

Quality gates for this project: `just check` — oxfmt-check on
`src/**/*.ts`, rumdl check on repo-root `*.md` only, oxlint on
`src/`, `tsc --noEmit`, and `vitest run --coverage`. Auto-fix:
`just fix` — oxfmt write on `src/**/*.ts`, rumdl fmt on
repo-root `*.md`, and oxlint `--fix` on `src/`.

Note that markdown gates only cover files at the repo root;
`docs/ARCHITECTURE.md` and any future `docs/**/*.md` files are
outside the default just recipes and must be validated
manually with `rumdl check docs/**.md`.

TypeScript at maximum strictness. oxlint with all 6 categories
at error level, 7 plugins. See `tsconfig.json` and
`.oxlintrc.jsonc`.

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

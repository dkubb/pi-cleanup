# Pi Cleanup Extension

`pi-cleanup` is a [pi](https://github.com/badlogic/pi) extension
that hooks into the `agent_end` event to ensure the repository stays
clean and well-structured after each agent interaction. It commits
uncommitted work, runs user-configured quality gates, verifies commits
are atomic, and wraps the cleanup in a boomerang anchor/collapse to
minimize token cost.

## What It Does

After every completed agent run, this extension executes a pipeline:

1. **Gate phase** — runs the configured quality gate commands
   (formatter, linter, tests). On failure, sends the agent a fix
   message.
2. **Dirty tree phase** — detects uncommitted changes via `git status
   --porcelain` and asks the agent to commit them.
3. **Review phase** — inspects new commits since the last clean SHA and
   asks the agent to correct any issues.
4. **Atomicity phase** — compares HEAD against the session base SHA (or
   merge-base with `main`/`master`/`develop`) and asks the agent to
   factor non-atomic commits.
5. **Eval phase** — prompts the agent to verify that the original task
   is actually complete before finishing.
6. **Collapse** — navigates the session tree back to the anchor,
   dropping cleanup context from the prompt.

When a phase needs agent action, the handler calls
`pi.sendUserMessage(...)`, which starts a new agent run. When that run
ends, `agent_end` fires again and the pipeline re-evaluates from the
top.

## Hook Point

This extension uses `agent_end`, not `turn_end`. `turn_end` fires after
every intermediate assistant turn; `agent_end` fires once after the
agent loop fully drains. This keeps cleanup work from interleaving with
in-flight tool calls.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design,
including the state machine specification and the boomerang integration
details.

## State Machine

The cleanup process is modeled as a finite state machine with six
resting states: `Idle`, `WaitingForTreeFix`, `WaitingForGateFix`,
`WaitingForFactoring`, `AwaitingUserInput`, and `Disabled`. Transitions
are driven by a `TransitionEvent` tagged enum and resolved by a pure
`transition(state, event)` function.

The state machine is implemented with Effect's `Data.TaggedEnum` for
structural equality and `Match.exhaustive` for compile-time
exhaustiveness checking.

## Commands

The extension registers two slash commands:

- `/gates` — open an editor to configure one gate command per line.
  Subcommands: `/gates show` lists the current config, `/gates clear`
  removes it.
- `/cleanup` — control the extension lifecycle. Subcommands: `on`,
  `off`, `resume` (clears `AwaitingUserInput`), `status` (default), and
  `collapse` (used internally by the pipeline).

Gate configuration is persisted via `pi.appendEntry` and restored on
`session_start`.

## Project Layout

```text
src/
├── index.ts              # Extension entry, event wiring
├── commands.ts           # /gates and /cleanup handlers
├── pipeline.ts           # Top-level agent_end orchestration
├── pipeline-phases.ts    # Phase runners (gate, dirty tree, atomicity)
├── pipeline-review.ts    # Commit review phase
├── state-machine.ts      # CleanupState, TransitionEvent, transition()
├── types.ts              # Branded primitives via Effect Schema
├── runtime.ts            # Mutable runtime state shape
├── persistence.ts        # appendEntry helpers + entry type constants
├── restore.ts            # Session entry restoration
├── status.ts             # Status footer indicator
└── phases/
    ├── dirty-tree.ts     # Dirty tree detection + fix message
    ├── gates.ts          # Gate execution + fix message
    ├── atomicity.ts      # Atomicity check + factor message
    ├── git-status.ts     # Base SHA resolution and mutation detection
    └── review.ts         # Review prompt construction
test/                     # Vitest unit tests mirroring src/
```

## Design Choices

- **Effect-TS throughout** — branded types via `Schema.brand` ("Parse,
  Don't Validate"), `Data.TaggedEnum` for discriminated unions,
  `Either` and `Option` for fallible and optional values, `Match` for
  exhaustive pattern matching.
- **Session-scoped persistence** — gate config and the last clean
  commit SHA live in the pi session, not a project file. Gate clears
  are durable via a tombstone entry.
- **Required gate configuration** — when no gates are configured, the
  handler transitions to `AwaitingUserInput(GatesUnconfigured)` rather
  than silently skipping.
- **Attempt limiting** — each waiting state carries an attempt counter.
  After five failed re-entries, the handler transitions to
  `AwaitingUserInput(Stalled)` and notifies the user.

## Development

The project uses [just](https://github.com/casey/just) as the task
runner.

```text
just check    # oxfmt + rumdl + oxlint + mermaid validation + tsc + vitest
just fix      # oxfmt + rumdl fmt + oxlint --fix
just test     # vitest run with coverage
just fmt      # format src and markdown in place
just typecheck # tsc --noEmit
```

Every commit must pass `just check`. TypeScript is configured at
maximum strictness; oxlint runs with all six categories at error level
across seven plugins.

## Git Hooks

Run `just install-hooks` once after cloning to enable the commit-body
line-length check.

The repo-local `commit-msg` hook rejects any non-subject commit body
line longer than 72 characters.

## Dependencies

- `effect` — branded types, tagged enums, exhaustive matching, Either,
  Option
- `@mariozechner/pi-coding-agent` — the `ExtensionAPI` and event types
- `@mariozechner/pi-ai` — model types (transitive)
- `@sinclair/typebox` — required by pi for tool parameter schemas

Dev tooling: `vitest`, `@vitest/coverage-v8`, `oxlint`, `oxfmt`,
`typescript`, `tsx`, `@mermaid-js/mermaid-cli`, `puppeteer`.

### Agent-Side Requirements

The atomicity phase asks the agent to split non-atomic commits using
the [`git-factor`](https://github.com/dkubb/git-factor) skill, which
must be available to the agent running cleanup.

## Related Documents

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions, type
  system patterns, state machine specification, boomerang integration.

#!/bin/bash
# RPC driver that dogfoods the cleanup extension while writing tests.
#
# Loads the extension in this project's own directory, configures
# `just check` as the gate, and tasks the agent with writing tests
# for key modules. The extension fires on each agent_end, running
# the full pipeline (gates → dirty tree → atomicity → eval).
#
# Exits non-zero if the agent becomes idle for longer than IDLE_TIMEOUT
# seconds (indicating it is stuck or the connection dropped).
set -euo pipefail

CLEANUP_EXT="./src/index.ts"
BOOMERANG_EXT="/Users/dkubb/workspace/nicobailon/pi-boomerang/index.ts"

# How long (seconds) without any event before we consider the agent stuck.
IDLE_TIMEOUT="${IDLE_TIMEOUT:-120}"

cd /Users/dkubb/workspace/dkubb/pi-cleanup

coproc PI {
  pi --mode rpc --no-session --no-skills --no-prompt-templates -ne \
    -e "$BOOMERANG_EXT" \
    -e "$CLEANUP_EXT" \
    --model 'anthropic/claude-sonnet-4' 2>/dev/null
}
PI_PID=$PI_PID
trap 'kill $PI_PID 2>/dev/null || true' EXIT

send() { echo "$1" >&"${PI[1]}"; }

# Read events for a fixed duration. Used for short command responses.
# Returns 0 always (timeout is expected for commands).
read_for() {
  local secs="$1"
  local deadline=$((SECONDS + secs))
  while [ $SECONDS -lt $deadline ]; do
    local remaining=$((deadline - SECONDS))
    [ "$remaining" -le 0 ] && break
    if IFS= read -r -t "$remaining" line <&"${PI[0]}"; then
      handle_event "$line"
    fi
  done
}

# Read events until idle timeout. Used for the main task where we
# expect continuous activity. If no event arrives within IDLE_TIMEOUT
# seconds, prints an error and exits with code 2.
read_until_idle() {
  while true; do
    if IFS= read -r -t "$IDLE_TIMEOUT" line <&"${PI[0]}"; then
      handle_event "$line"
    else
      echo ""
      echo "!!! TIMEOUT: No events for ${IDLE_TIMEOUT}s — agent appears stuck."
      echo "!!! Killing pi process and exiting."
      kill "$PI_PID" 2>/dev/null || true
      exit 2
    fi
  done
}

# Process a single JSON event line. Responds to editor UI requests.
handle_event() {
  local line="$1"
  local type
  type=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('type',''))" <<< "$line" 2>/dev/null || echo "?")
  case "$type" in
    response)
      echo "[resp] $(python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d.get(\"command\",\"?\")} ok={d.get(\"success\",\"?\")}')" <<< "$line")" ;;
    extension_ui_request)
      local method
      method=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('method',''))" <<< "$line")
      case "$method" in
        notify)
          echo "[notify] $(python3 -c "import sys,json; d=json.load(sys.stdin); print(f'[{d.get(\"notifyType\",\"\")}] {d.get(\"message\",\"\")[:140]}')" <<< "$line")" ;;
        setStatus)
          echo "[status] $(python3 -c "import sys,json; d=json.load(sys.stdin); k=d.get('statusKey',''); v=d.get('statusText'); print(f'{k}={v[:60] if v else \"(clear)\"}')" <<< "$line")" ;;
        editor)
          local rid
          rid=$(python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" <<< "$line")
          echo "[editor] auto-reply: just check"
          send "{\"type\":\"extension_ui_response\",\"id\":\"$rid\",\"value\":\"just check\"}" ;;
        *) echo "[ui:$method]" ;;
      esac ;;
    agent_start) echo "--- agent_start ---" ;;
    agent_end)   echo "--- agent_end ---" ;;
    session_tree) echo "*** SESSION_TREE (context collapsed) ***" ;;
    extension_error)
      echo "!!! ERROR: $(python3 -c "import sys,json; print(json.load(sys.stdin).get('error','')[:200])" <<< "$line")" ;;
    tool_execution_end)
      echo "[tool] $(python3 -c "import sys,json; print(json.load(sys.stdin).get('toolName','?'))" <<< "$line") done" ;;
    *) ;;
  esac
}

echo "===== STARTUP ====="
read_for 3

echo ""
echo "===== /boomerang tool on ====="
send '{"type":"prompt","message":"/boomerang tool on"}'
read_for 3

echo ""
echo "===== /gates (configure with just check) ====="
send '{"type":"prompt","message":"/gates"}'
read_for 5

echo ""
echo "===== /gates show ====="
send '{"type":"prompt","message":"/gates show"}'
read_for 3

echo ""
echo "===== TASK: Write tests for key modules ====="
TASK=$(cat << 'PROMPT'
You are working on a pi extension project at /Users/dkubb/workspace/dkubb/pi-cleanup

Read these files to understand the project:
- src/types.ts (branded types)
- src/state-machine.ts (transition function)
- src/phases/dirty-tree.ts (git status check)
- src/phases/gates.ts (gate execution)
- src/phases/atomicity.ts (atomicity check)
- src/persistence.ts (session persistence)
- src/restore.ts (session restoration)
- test/types.test.ts (existing seed test)
- vitest.config.ts (coverage config)

Your task: Write comprehensive tests for the most critical modules to
increase test coverage. Focus on these files IN THIS ORDER:

1. test/state-machine.test.ts - Test the transition() function with
   key state×event combinations. Test isActionable(). This is the
   highest-value target since it's the core state machine.

2. test/phases/dirty-tree.test.ts - Test checkGitStatus() and
   buildDirtyTreeMessage() with mocked ExecFn.

3. test/phases/gates.test.ts - Test runGates() and buildGateFixMessage()
   with mocked ExecFn.

4. test/phases/atomicity.test.ts - Test checkAtomicity(),
   getDefaultBaseSHA(), and buildFactorMessage() with mocked ExecFn.

5. test/persistence.test.ts - Test persistGateConfig(),
   persistGatesClear(), persistCleanCommit().

6. test/restore.test.ts - Test restoreGateConfig() and
   restoreCommitSHA() with valid, invalid, and edge-case data.

IMPORTANT RULES:
- After EACH test file you write, run `just check` to verify it passes.
- After each successful `just check`, read coverage/coverage-summary.json
  and update vitest.config.ts thresholds to match the FLOOR of the current
  coverage percentages (round DOWN to nearest integer). Thresholds must
  NEVER decrease — only ratchet up.
- Commit each test file individually with a proper conventional commit.
- All functions are dependency-injected (ExecFn, AppendEntryFn) so tests
  use simple mocks — no need for complex test infrastructure.
- Use Effect's Either and Option in tests the same way the source does.
- Create the test/phases/ directory if it doesn't exist.
PROMPT
)

send "{\"type\":\"prompt\",\"message\":$(python3 -c "import json; print(json.dumps('''$TASK'''))")}"
echo "(agent working — will exit if idle for ${IDLE_TIMEOUT}s...)"
read_until_idle

# If we get here, read_until_idle returned normally (shouldn't happen
# since it loops forever or exits on timeout). Treat as unexpected.
echo "!!! Unexpected: read_until_idle returned"
exit 1

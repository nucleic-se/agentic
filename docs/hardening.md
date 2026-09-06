# Hardening cycle — September 2026

The repository audit at `38d0241` produced 12 confirmed findings. The first
remediation and hardening cycle fixes all 12 and adds integration regressions in
`runtime/Hardening.test.ts`.

| Audit finding | Resolution |
| --- | --- |
| F1: symlink escape | Reject symlink components, including dangling links, below filesystem root |
| F2: replacement interpolation | Literal replacement callback |
| F3: overlapping patches | Validate each operation against working content before commit |
| F4: protected ancestor removal | Reject root and protected ancestor mutations |
| F5: incomplete streams | Require terminal completion; reject errors and malformed events |
| F6: Codex truncation | Token-limit status precedes tool execution |
| F7: missing token counts | Report both structured and text LlmGraphNode usage |
| F8: graph time ceiling | Run deadline reaches active asynchronous work and resume |
| F9: changing audit records | Snapshot request messages and tool definitions |
| F10: confirmation mismatch | Transform and validate before policy/confirmation; enforce authorized arguments |
| F11: HTTP body bounds | Deadline and byte ceiling span body consumption |
| F12: repeated hints | Persist fired thresholds in serializable state |

The first hardening cycle additionally isolates concurrent graph counters,
rejects duplicate Codex calls and non-object tool arguments, bounds SSE buffers,
cleans up readers on failure, and prevents repeated validation from changing
an authorized operation. Invalid turn and graph-limit configurations fail early.

Validation: 314 tests pass, including 23 new regression cases, and TypeScript
build succeeds. Package exports are checked separately before delivery.

Remaining validation work: live provider/OAuth smoke tests, supported Node and
OS matrix, and fault injection against real transports and subprocess trees.
The library is not an OS sandbox: filesystem entry races require host isolation,
synchronous JavaScript cannot be preempted, and cancellation cannot undo external
side effects. Token limits between nodes cannot prevent an individual provider
call from overshooting its remaining token budget.

Subsequent hardening should extend streaming bounds to non-streaming provider
JSON/error bodies, exercise kernel extension failures and cancellation races,
and review built-in shell/search/skill tools under an explicit host trust model.

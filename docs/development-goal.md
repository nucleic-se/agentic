# Standalone agent development

Work through these phases in order. This is an acceptance plan, not a list of
completed features. Shared agent behavior belongs in Agentic; durable worker,
queue, scheduling and transaction integration belongs in its host.

## 1. Context and task-state fidelity

Exercise repeated checkpoints with changing requirements, contradictory evidence,
completed steps and unfinished verification. Check exact source references and
archive recovery, not merely whether the request fits. Retain explicitly pinned
instructions independently of generated summaries. Record maintenance and task
usage, retrievals, completion and incorrect conclusions in isolated live runs.
Hold the model, prompt and budgets fixed when comparing policies.

Current evidence: pinned instruction retention and archive identity recovery are
implemented and tested. Isolated host trials exercised repeated automatic
checkpoints, exact source recovery and reopen. Two trials with explicit
verification semantics retained unfinished work through five and six checkpoints.
This phase remains open: the default composition can discard the original task
requirement when a later "Continue" becomes the protected current message, and
Gears currently fails a task when a generated checkpoint exceeds its character
limit. Align objective retention and recoverable maintenance behavior across the
two compositions before expanding recall or interface features.

## 2. A complete coding workflow

Use shared project-instruction discovery and a small read/edit/execute tool pack
in both compositions. Demonstrate a real change and its verification in a disposable
workspace. Exercise interruption, inspect the recorded outcome, and resolve an
ambiguous operation explicitly without silently replaying it. Preserve the host's
authorization policy and delegated capability restrictions.

Current evidence: both compositions use the shared coding pack and startup
instruction discovery, including nested directory rules. Live disposable coding
tasks changed source, preserved tests and ran verification. An actual process-kill
scenario exercised inspection, explicit tool resolution, paused continuation and
no replay of the completed effect. This evidence remains valid; dependable long
coding tasks still require the context work in phase 1. Richer recovery UI remains
part of phase 4.

## 3. Cross-task recall

Start with bounded durable notes and text search with source provenance. Prove
that a later task can find relevant prior work, distinguish outdated information
and recover its source after restart. Compare task quality and overhead with recall
disabled before considering more complex retrieval.

Current progress: bounded SQLite notes preserve source-linked revisions and reject
stale updates. Both compositions opt into the shared recall tools and resolve
evidence from host-owned sessions. Integration tests capture a receipt, reopen both
stores, and recall its evidence in another task. Live runs exposed hidden receipt
identities, now rendered explicitly and included in budgeting. Both compositions
then saved notes successfully. A small follow-up review comparison answered
correctly with and without recall but did not show a token-efficiency benefit.
Source access beyond captured excerpts now uses paged archive retrieval with a
saved fingerprint. Restart tests reconstruct the original receipt in a new task
and reject changed sources. Demonstrated useful reuse remains required before
this phase is accepted.

## 4. Interface and extension usability

Make the terminal and phone-sized web interface useful for starting, steering,
inspecting and recovering work. Verify rendered behavior and real state changes.
Provide a documented extension configuration workflow with actionable errors;
exercise a shared extension in both compositions. Favor coherent daily use over
the number of bundled integrations.

## Completion evidence

Current work order: close the context-continuity and checkpoint-recovery gaps,
reduce active-state/list payload growth while retaining exact traces, then resume
the recall usefulness gate and interface work. Keep optional recall bounded while
its benefit remains unproven. Passing storage or tool tests alone cannot close an
end-to-end task requirement.

Each phase requires appropriate automated checks, isolated live dogfooding,
inspectable requests and outcomes, and documented limitations. Keep run artifacts
outside source control. Passing one task does not demonstrate general reliability.
The goal remains open until all four phases have direct evidence.

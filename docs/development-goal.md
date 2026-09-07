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
verification semantics retained the required unfinished work through five and
six checkpoints. Summary interpretation and maintenance overhead remain measured
limitations; this supports proceeding to phase 2, not a general reliability claim.

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
no replay of the completed effect. Phase 3 can proceed; richer recovery UI remains
part of phase 4.

## 3. Cross-task recall

Start with bounded durable notes and text search with source provenance. Prove
that a later task can find relevant prior work, distinguish outdated information
and recover its source after restart. Compare task quality and overhead with recall
disabled before considering more complex retrieval.

Current progress: a bounded SQLite implementation of the memory contract preserves
source-linked revisions across reopen and rejects stale updates. Storage checks
pass; harness source resolution, shared recall tools and live recall comparisons
remain required before this phase is accepted.

## 4. Interface and extension usability

Make the terminal and phone-sized web interface useful for starting, steering,
inspecting and recovering work. Verify rendered behavior and real state changes.
Provide a documented extension configuration workflow with actionable errors;
exercise a shared extension in both compositions. Favor coherent daily use over
the number of bundled integrations.

## Completion evidence

Each phase requires appropriate automated checks, isolated live dogfooding,
inspectable requests and outcomes, and documented limitations. Keep run artifacts
outside source control. Passing one task does not demonstrate general reliability.
The goal remains open until all four phases have direct evidence.

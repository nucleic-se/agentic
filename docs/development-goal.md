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

## 2. A complete coding workflow

Use shared project-instruction discovery and a small read/edit/execute tool pack
in both compositions. Demonstrate a real change and its verification in a disposable
workspace. Exercise interruption, inspect the recorded outcome, and resolve an
ambiguous operation explicitly without silently replaying it. Preserve the host's
authorization policy and delegated capability restrictions.

## 3. Cross-task recall

Start with bounded durable notes and text search with source provenance. Prove
that a later task can find relevant prior work, distinguish outdated information
and recover its source after restart. Compare task quality and overhead with recall
disabled before considering more complex retrieval.

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

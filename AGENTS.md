# Agentic architecture boundary

Agentic owns reusable agent-runtime and tool-execution mechanisms. Application
business logic, private infrastructure identities and application workflows belong
in callers or agent workspaces, never in this library.

Treat external CLI commands and outputs as opaque application data. Generic
process handles, receipts, cancellation, deadlines and ownership may belong here;
application-specific identifiers, status interpretation and recovery do not.
Use generic identifiers and synthetic commands in tests. Consumer-specific policy
and deployment choices belong in the host or operator project.

Preserve unrelated local changes. Behavioral changes require a failing regression
before implementation and relevant build/tests before handoff.

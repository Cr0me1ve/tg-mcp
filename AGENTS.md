# Project agent instructions

## Project plan

- At the start of every task in this repository, read `PLAN.md` before making
  changes.
- Treat `PLAN.md` as the source of truth for the current MVP scope and
  architecture.
- When the user introduces a new requirement, add it to `PLAN.md` and update
  any affected plan sections before implementing that requirement.

## Delegation

- Only the root agent may spawn subagents.
- Subagents MUST NOT spawn or delegate to other subagents.
- Keep delegation shallow: at most one level below the root agent.
- Delegate only concrete work with explicit ownership and expected output.
- Follow the test and documentation delegation rules below, including the exception for very small edits.

### Tests

- Delegate test creation and test updates to a `gpt-5.6-terra` test agent, except for very small edits of only a few lines.
- Running existing tests, builds, linters, and verification commands stays with the root agent.
- Use one test agent per task unless test areas are completely independent.
- The test agent owns only test files.
- The test agent MUST NOT modify production code or create production helpers unless the root agent explicitly assigns those files.
- Match the Terra agent's reasoning effort to the complexity of the test work.

### Documentation

- The root agent may handle very small documentation edits of only a few lines without delegation.
- Delegate larger documentation creation and updates to `gpt-5.6-terra`.
- Documentation includes README files, standalone guides, API references, release notes, and user-facing operational instructions.
- Code comments and UI labels are production-code changes and may be handled by the root agent.
- Documentation agents MUST NOT modify production code.

### Coordination

- Every delegated task must specify exact file ownership, expected output, and verification commands.
- Every delegated task must state that the agent is not alone in the repository and must not revert other changes.
- The root agent remains responsible for integration, final verification, and user communication.

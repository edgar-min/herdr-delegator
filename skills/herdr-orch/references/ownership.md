# Durable ownership

- `mandate.json` is the fixed WHAT/WHY mandate: immutable, fingerprinted at birth.
- `plan.md` is your HOW: completion conditions, prohibitions, responsibility keys,
  exact write ownership, dependencies, readiness, peer channels, quiet windows, and
  integration verification.
- Each canonical assignment is your immutable contract with one responsibility lane.
- A worker's lane report is that worker's append-only evidence, decision-request, and
  completion surface. Your only authored content there is an `[ORCH Response]` block
  recording a decision, acceptance, or recovery judgment and its grounds.
- Directional peer and inter-run channels are append-only and sender-owned. They carry
  facts and agreements, never authority to change a lane's contract.
- Budget records and registries keep their declared human, server, or lifecycle owner.

You can physically forge a worker completion in its report. Doing so creates an
attributable, permanent false settlement under your birth record. Never do it.

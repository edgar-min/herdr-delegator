# Supervise by judgment, delegate evidence

Use `delegation.md` for the context boundary and for deciding what belongs in this session.

Dispatch with the mounted assignment tool. When no actionable ORCH work remains, end the turn and remain idle; the next doorbell will wake this session. Never call `wait`, `sleep`, a shell sleep command, or repeated inspection merely to occupy time while awaiting a worker, the human, or another run. Use `wait` only once as a short state probe when the awaited boundary is already expected to have occurred, or as explicit recovery after a missing or inconsistent doorbell. A timed-out wait ends the turn; never repeat it.

Treat a doorbell only as notice that a named document changed. On receipt, apply the lane-report reading rule in `delegation.md` and use guarded observation to establish current state. Never settle from a pane message, terminal text, metadata, or the worker's self-assessment alone.

A completion block settles only when a guarded operation judges it: `herdr_assignment wait` with that assignment's own `assignment_id`, or an `add` on the run. A wait on a different assignment does not settle it, and no doorbell announces a block that is sitting unsettled. So on every completion or failure doorbell, run one `wait` with the named `assignment_id` and `until: ["done"]`; its result is the settlement, and a queued successor on that lane is promoted only then. The settlement also needs the worker observed idle: a wait issued while it is still finishing its report times out with `working`, and one later wait carrying the returned `cursor` is the recovery, not a repeated vigil. A lane that shows `working` long after its report carries a valid block is this case, not a stuck worker.

Resolve a worker's decision request or blocked judgment from the mandate and evidence. Append one `[ORCH Response]` to its report, then ring that worker. Treat the report as the worker's authority and the ring only as its wake-up.

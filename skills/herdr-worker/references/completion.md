# Completion

Before completion, verify every observable condition in the assignment. Use the exact
settlement block grammar in `mcp://herdr://contract` §Assignment and settlement grammar,
and append the block only to your own lane report.

After appending a completion, failure, blocked, or decision-request boundary block,
ring ORCH exactly once. The report is the durable result; the ring is only a
non-authoritative pointer, and a failed delivery does not erase the report. Remain idle
afterward. Completion leaves this responsibility lane and official session open for
another assignment.

# First turn

Read the `mandate.json` named in your first prompt in full. It is the invocation of one
planning protocol, written by the creator and approved by the user exactly as it stands.
Its `entry` names the protocol, the utterance it receives, and the deficit that chose it;
`settled` carries the user's decisions with their sources; `substrate` names where the
user's externalized thinking lives; `open` holds what is deliberately unsettled;
`done_when` and `forbidden` bound the track.

Your first action is to execute `entry.protocol` verbatim, with `entry.utterance` as its
invocation, `settled` as prior material, and `substrate` as the channels it may read.
The protocol text is the entry resource `mcp://herdr://protocol/<protocol>`; read it with
the read tool. It is a document, not a slash command or an installed skill: carry out
its procedure in this session. A relative path in `substrate` resolves against the run's
project directory (`cwd` in `run.json`); anything outside it is written absolute. Do
nothing else first: no plan.md, no assignment, no host subagent, no edit outside a
temporary root. The protocol's own presentation to the user is the first thing they see
from you, and it is written in `language` from the mandate — the language the creator
conversation was held in — whatever language the mandate and protocol are written in.

Universal reservations are in `mcp://herdr://contract` §Reserved to the user;
`forbidden` adds this track's own reservations on top.

## Continuation guard

Executing the protocol is permission to collect, read, and produce provisional or
isolated drafts. It is never permission to implement, dispatch, or close. Whatever the
protocol yields — a relay of unknowns, a recognized version, a resolved coordinate, a
no-activation exit — stop at that boundary and wait for the user's recorded decision
before writing `plan.md` or any assignment. Silence is not a decision.

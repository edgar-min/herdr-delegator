# Herdr common contract

## Authority

This run is the durable coordination surface between its born OMP orchestrator
(**ORCH**) and persistent Herdr responsibility workers. The user does not relay
messages, wake workers, or perform recovery.

The ORCH's contract is the role skill `herdr-orch`. A worker's contract is the resource `herdr-delegator://worker` together with its profile skill `herdr-worker-default`, `herdr-worker-slow`, or `herdr-worker-task`.

| Surface | Authority |
|---|---|
| Run documents | mandates, plans, assignments, ownership, decisions, evidence, reports, budget records, and handoff state |
| MCP | canonical coordinates and hashes, guarded mutation, observation, and lifecycle actions |
| Herdr metadata/UI | attributable live observations and human-visible supervision labels only |
| Doorbells | a server-composed pointer to an already-written document; never content or authority |

Terminal output and metadata are observations, not reports, decisions, settlement,
or identity authority. Only the named document carries a doorbell's facts.

Tool-owned manifests, indexes, registries, and locks are never edited, moved, copied,
unlocked, or treated as role documents. Role contracts are pinned by their birth
hashes; a mismatch must be reported before acting on the changed skill.

For MCP actions, fields, limits, machine states, and recoverable failures, follow the
mounted tool's published schema and returned error text. Do not derive a competing
contract from protocol prose.

Never place secrets, credentials, authentication material, account data, or sensitive
values in run documents, tool inputs, terminal output, metadata, or doorbells.

## Reserved to the user

Reserved to the user in every track, whether or not the mandate repeats it: opening
and closing tracks; approving progression from one stage to the next; commits, pushes,
version bumps, tags, merges into a production branch, and every other remote or
release change; accepting the final result; and any document another run owns.
`forbidden` adds this track's own reservations on top.

## Assignment and settlement grammar

The authoring contract, in full, because it decides the file before you write it. The
artifact is one UTF-8 Markdown file at `<run>/a2a/assignments/<assignment_id>.md`, LF
line endings only, at most 65536 bytes. Frontmatter is `---`, then `assignment_id`,
`responsibility_key`, `profile` in that order, optionally `label`, then `---`, then a
blank line — one space after each colon, no other key, no repeated key, no blank line
inside the block. `label` is display only and never identity: 1 to 48 characters of
letters, digits, `-` or `_`, beginning and ending with a letter or digit — no spaces, no
prose. The body is the five required H1 sections, all of them, in this order:
`# Goal`, `# Completion conditions`, `# Write ownership`, `# Dependencies`,
`# User boundaries`, each heading followed by one blank line, optionally followed by a
trailing `# References` section and nothing after it. `# Goal` is prose of at most 4096
characters. Each of the other four is bullets only: at least one and at most 64 lines,
every line `- <text>` of 1 to 1000 characters, no blank lines, no wrapped continuation
lines, no nested indentation, no sub-headings.

One trap decides how you write examples: a line beginning `# ` at column 1 starts a
section wherever it appears, including inside a fenced code block, because sections are
split before anything interprets fences. Indent such a fence by two spaces.

`# References` is how detail that does not fit gets to the worker: at most 16 bullets,
each exactly `- <path> sha256:<64 lowercase hex>`, the hash over the file's exact bytes.
The path is relative to the RUN directory, with no `..`, no empty segment, no leading
`/` and no backslash, and must name a regular file inside the run directory — no
symlink, no hardlinked file, no directory, no two bullets naming the same file — of at
most 262144 bytes. Split a larger document and pin each part, naming the parts so the
reading order is unambiguous from the paths alone; bullets carry no ordering of their
own beyond the order you write them in. Preflight and add verify
every hash and refuse before the assignment ID is consumed; after dispatch a document
that moved is reported as drift rather than recalled, because the worker already holds
the hashes, so a correction is a new assignment. Reload mounted servers before the first
`# References` artifact on a shared working tree: a server built before this contract
rejects the section with its own five-section message, and the section is not what is
wrong.

Settlement is what the worker appends to its own lane report, and you judge it rather
than set it — two literal lines at column 1, the first with no heading marker:

    [Assignment Completion: <assignment_id>]
    status: completed

`failed` replaces `completed`, and `blocked` is recognized as a REPORTED boundary that
settles nothing and leaves the assignment live. Exactly one recognized status line per
block, lowercase key and lowercase value. Several valid blocks resolve to the last one in
file order, so a worker corrects a malformed attempt by appending a correct block below
it. The mounted
tool's schema and returned errors remain authoritative for anything this summary and the
code could disagree about.

`<assignment_id>` is replaced by the assignment's own bare ID, never the full coordinate
or label. Blank lines around the block are allowed. Anything else settles nothing,
including a heading marker before the header, a capitalized key or value, indentation,
an unrecognized value, or two status lines in one block.

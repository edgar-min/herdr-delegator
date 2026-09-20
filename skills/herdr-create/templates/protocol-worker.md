---
delivery: herdr-packaged-role-skills/1
role: worker
skill: herdr-default-worker herdr-task-worker herdr-slow-worker
---

# Backing record — worker delivery

This run delivers worker operating instructions from the installed packaged skill
selected by the lane's assignment profile: `default` → `herdr-default-worker`,
`task` → `herdr-task-worker`, `slow` → `herdr-slow-worker`. This file is a machine
selection record, not instructions: dispatch resolves the installed
`skills/<name>/SKILL.md` of the running package and names its path in the lane's
assignment prompt, together with that profile's configured advisory criteria inline.

The bytes of this file are what select that delivery. They are never edited in place;
a run created under an older backing contract keeps the delivery its own accepted
bytes describe.

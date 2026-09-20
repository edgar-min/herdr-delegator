---
delivery: herdr-packaged-role-skills/1
role: orchestrator
skill: herdr-orch
---

# Backing record — orchestrator delivery

This run delivers orchestrator operating instructions from the installed packaged
skill `herdr-orch`. This file is a machine selection record, not instructions: the
spawn resolves the installed `skills/herdr-orch/SKILL.md` of the running package and
names its path in the ORCH's first prompt, together with any configured advisory
criteria inline.

The bytes of this file are what select that delivery. They are never edited in place;
a run created under an older backing contract keeps the delivery its own accepted
bytes describe.

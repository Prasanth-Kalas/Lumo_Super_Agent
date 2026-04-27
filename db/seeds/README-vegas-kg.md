# Vegas KG Synthetic Seed

`vegas-kg-synthetic.sql` loads the Synthetic Sam graph fixture used by KG-1
tests and demos. It assumes the fixture user already exists in
`public.profiles`; Supabase Auth owns that row, so production smoke tests should
usually seed through:

```text
POST /api/graph/rebuild?synthetic=1&apply=1
```

That route remaps the fixture onto the signed-in test user and preserves the
same graph shape: 147 nodes, 313 edges, and the two explicit `BLOCKED_BY` edges
from the canceled Tahoe mission to the board-meeting and storm-forecast blockers.

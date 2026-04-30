# Stub 3-Leg Trip

Synthetic COMPOUND-EXEC-1 fixture agent.

It commits two merchant-of-record legs and intentionally fails the third so
the compound graph runner can prove rollback ordering end-to-end without
touching real travel providers.

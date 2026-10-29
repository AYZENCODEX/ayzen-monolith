# Account lifecycle

Local identities start as `pending_verification`, then move to `active`,
`disabled`, or `recovery_required` through explicit transitions. A disabled
account cannot create a session or an identity link. Recovery is an explicit
state, not an implicit bypass.

Connected identity is a relationship state, not a replacement for the local
app account. Revoking a link does not delete app data or silently merge another
account.
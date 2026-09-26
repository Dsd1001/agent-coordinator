# Bounded Final Repair recovery policy

Reference `RecoveryPolicy` for a conservative one-shot repair lane.

It is intentionally **not** coordinator core behavior. The policy returns a normal retry while budget remains; at the normal attempt limit it emits exactly one `repair` action only when the review classification is `bounded` and structured blocking findings define the repair scope. Otherwise it escalates. A prior `repair` action prevents the policy from opening another final-repair lane.

Deployments may replace this package with any other recovery policy through `RECOVERY_POLICY_POINT`.

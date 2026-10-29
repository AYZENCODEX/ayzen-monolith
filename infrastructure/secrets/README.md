# Shared secrets control plane

This directory contains namespace and rotation policy only. Secret values never
belong in the repository. Runtime values are supplied by the workspace or
deployment secret manager and are referenced by name from the config registry.

Every secret reference declares its owner, environment, rotation class and
consumers. Rotation must support an overlap window, audit the change, and
reject activation when a required reference is missing.
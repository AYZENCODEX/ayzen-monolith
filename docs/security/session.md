# Session security

Sessions are expiry-bound, revocable, device-aware, and isolated by app and
principal. Service-to-service calls use audience and scope checks; logout and
backchannel logout propagate through the session boundary.
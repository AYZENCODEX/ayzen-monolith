# AYZEN Admin Domain

The Admin API is a control-plane boundary. It does not read application
databases directly. It accepts governed operational events and exposes
tenant-independent administrative views only to principals with explicit
`admin:*` scopes.

The Admin Telegram Bot uses the same capability and policy contracts through
the Telegram gateway. The verified numeric Telegram user ID is the owner
identity; the username is display metadata.
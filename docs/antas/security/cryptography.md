# Vault and cryptographic assurance

Key material is namespaced, rotated, access controlled, and never emitted in
logs. The repository records the key-management policy and vault implementation
controls. Real rotation, legacy decrypt, cross-user restore, and SSRF drills
must run against an approved environment.

The SSRF drill includes localhost, loopback, private IPv4/IPv6, the cloud
metadata address, DNS rebinding, and redirects to private addresses.
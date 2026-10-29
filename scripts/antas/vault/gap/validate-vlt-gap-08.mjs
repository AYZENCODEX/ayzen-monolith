#!/usr/bin/env node
// VLT-GAP-08 entry point — delegates to the generic, config-driven validator (gap-configs/08.mjs).
// Usage: node validate-vlt-gap-08.mjs --stage census|extract|rewire|retire
const args = process.argv.slice(2);
if (!args.includes("--gap")) process.argv.splice(2, 0, "--gap", "08");
await import("./validate-gap.mjs");

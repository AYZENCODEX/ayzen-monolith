#!/usr/bin/env node
// VLT-GAP-12 entry point — delegates to the generic, config-driven validator (gap-configs/12.mjs).
// Usage: node validate-vlt-gap-12.mjs --stage census|extract|rewire|retire
const args = process.argv.slice(2);
if (!args.includes("--gap")) process.argv.splice(2, 0, "--gap", "12");
await import("./validate-gap.mjs");

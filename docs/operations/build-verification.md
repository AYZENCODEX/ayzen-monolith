# Build verification

ZIOX-A requires a clean, reproducible install before a release can be promoted.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm --filter @workspace/api-server build
pnpm --filter @workspace/ayzen build
```

The API build writes `artifacts/api-server/dist/`; the frontend build writes
`artifacts/ayzen/dist/public/`. `pnpm validate:ziox` records the lockfile hash,
build manifest, command output, and any blocker under `reports/ziox/`.

Do not use `pnpm add`, manual package copies, or an uncommitted lockfile change
to get a release through CI. If a native dependency fails, update the workspace
package manifest and lockfile together, then repeat the frozen install.
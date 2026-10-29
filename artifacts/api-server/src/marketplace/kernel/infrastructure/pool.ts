/**
 * marketplace/kernel/infrastructure/pool.ts
 * MKT-03: the single place Marketplace code imports the database pool from. Every sub-module's infrastructure imports
 * `pool` from here, so tests and the boundary validator have one seam to look at.
 */
export { pool } from "@workspace/db";

/**
 * Runs at container start (see docker-entrypoint.sh):
 *   1. Ensure the pgvector extension exists.
 *   2. Apply all generated SQL migrations.
 *
 * Safe to run repeatedly — migrations are tracked by drizzle.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const sql = postgres(connectionString, { max: 1 });

  try {
    console.log("[migrate] ensuring pgvector extension…");
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;

    const db = drizzle(sql);
    console.log("[migrate] applying migrations…");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("[migrate] done.");
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});

// Runtime migration runner (plain ESM so it works inside the Next standalone
// image without tsx). Ensures pgvector exists, then applies drizzle migrations.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("[migrate] DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(connectionString, { max: 1 });

try {
  console.log("[migrate] ensuring pgvector extension…");
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  const db = drizzle(sql);
  console.log("[migrate] applying migrations…");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] done.");
} catch (err) {
  console.error("[migrate] failed:", err);
  process.exit(1);
} finally {
  await sql.end();
}

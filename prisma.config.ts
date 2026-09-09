import "dotenv/config";
import { defineConfig } from "prisma/config";

const directDatabaseUrl =
  process.env.DIRECT_DATABASE_URL ??
  "postgresql://prisma:prisma@localhost:5432/vistablox";

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: directDatabaseUrl,
  },
});

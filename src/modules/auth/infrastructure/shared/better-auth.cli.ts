import { Pool } from "pg";

import { createBetterAuth } from "./better-auth.factory.js";

export const auth = createBetterAuth({
  database: new Pool({
    connectionString:
      process.env.DATABASE_URL ?? "postgresql://auth:auth@localhost:5432/vistablox",
  }),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  secret:
    process.env.BETTER_AUTH_SECRET ??
    "development-only-better-auth-secret-change-me",
  secureCookies: false,
  trustedOrigins: [process.env.BETTER_AUTH_URL ?? "http://localhost:3000"],
});

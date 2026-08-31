import type { Logger } from "pino";

import type { AuthContext } from "../modules/auth/api/auth-context.js";

declare global {
  namespace Express {
    interface Locals {
      traceId?: string;
      logger?: Logger;
      authContext?: AuthContext;
    }
  }
}

export {};

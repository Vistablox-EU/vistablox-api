import type { Logger } from "pino";

import type { AuthContext } from "../modules/auth/api/auth-context.js";

declare global {
  namespace Express {
    interface Locals {
      traceId?: string;
      logger?: Logger;
      authContext?: AuthContext;
      /** Set by requireDpopOnly for the "none (DPoP only)" endpoints (C1/E1/L1). */
      dpopJkt?: string;
    }
  }
}

export {};

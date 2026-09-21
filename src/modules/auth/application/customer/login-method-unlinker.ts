import type { IncomingHttpHeaders } from "node:http";

export type UnlinkableLoginMethodType = "google" | "apple";

export class LoginMethodNotLinkedError extends Error {
  public constructor(public readonly methodType: UnlinkableLoginMethodType) {
    super(`Login method not linked: ${methodType}`);
  }
}

export class RegistrationLoginMethodLockedError extends Error {
  public constructor(public readonly methodType: UnlinkableLoginMethodType) {
    super(`Login method used at registration can't be unlinked: ${methodType}`);
  }
}

export interface LoginMethodUnlinker {
  unlink(methodType: UnlinkableLoginMethodType, headers: IncomingHttpHeaders): Promise<void>;
}

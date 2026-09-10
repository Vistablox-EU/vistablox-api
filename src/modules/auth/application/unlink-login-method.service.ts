import type { IncomingHttpHeaders } from "node:http";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  LoginMethodNotLinkedError,
  RegistrationLoginMethodLockedError,
  type LoginMethodUnlinker,
  type UnlinkableLoginMethodType,
} from "./login-method-unlinker.js";

export class UnlinkLoginMethodService {
  public constructor(private readonly unlinker: LoginMethodUnlinker) {}

  public async execute(
    methodType: UnlinkableLoginMethodType,
    headers: IncomingHttpHeaders,
  ): Promise<void> {
    try {
      await this.unlinker.unlink(methodType, headers);
    } catch (error) {
      if (error instanceof RegistrationLoginMethodLockedError) {
        throw new AppError({
          code: "authentication.registration_login_method_locked",
          title: "Sign-in method can't be removed",
          status: 409,
          detail:
            "The sign-in method used to create this account can't be unlinked. Link an additional sign-in method first if you want to change how you sign in.",
        });
      }
      if (error instanceof LoginMethodNotLinkedError) {
        throw new AppError({
          code: "authentication.login_method_not_linked",
          title: "Sign-in method not linked",
          status: 404,
          detail: "That sign-in method is not linked to this account.",
        });
      }
      throw error;
    }
  }
}

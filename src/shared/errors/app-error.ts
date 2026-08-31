export interface FieldError {
  field: string;
  code: string;
  message: string;
}

interface AppErrorOptions {
  code: string;
  title: string;
  status: number;
  detail: string;
  type?: string;
  fieldErrors?: FieldError[];
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly title: string;
  public readonly status: number;
  public readonly type: string;
  public readonly fieldErrors: FieldError[] | undefined;

  public constructor(options: AppErrorOptions) {
    super(options.detail, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.title = options.title;
    this.status = options.status;
    this.type = options.type ?? `https://api.vistablox.eu/errors/${options.code}`;
    this.fieldErrors = options.fieldErrors;
  }
}

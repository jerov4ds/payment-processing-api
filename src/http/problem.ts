import {
  CodedError,
  PayloadTooLargeError,
  ValidationError,
} from "../domain/errors";

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  MISSING_IDEMPOTENCY_KEY: 400,
  UNAUTHORIZED: 401,
  ROUTE_NOT_FOUND: 404,
  PAYMENT_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  VERSION_CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  NOT_READY: 503,
  STORAGE_UNAVAILABLE: 503,
  STORAGE_CORRUPT: 503,
};

const TITLE_BY_STATUS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export interface ProblemErrorItem {
  path: string;
  message: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
  errors?: ProblemErrorItem[];
  stack?: string;
}

export interface ProblemContext {
  requestId: string;
  instance: string;
  problemBaseUri: string;
  exposeStack: boolean;
}

export function toProblem(error: unknown, context: ProblemContext): Problem {
  if (isPayloadTooLarge(error)) {
    return fromCoded(new PayloadTooLargeError(), context);
  }
  if (isJsonSyntaxError(error)) {
    return fromCoded(
      new ValidationError("Request body is not valid JSON"),
      context,
    );
  }
  if (error instanceof CodedError) {
    return fromCoded(error, context);
  }
  const problem: Problem = {
    type: problemType(context.problemBaseUri, "INTERNAL_ERROR"),
    title: "Internal Server Error",
    status: 500,
    detail: "An unexpected error occurred.",
    instance: context.instance,
    code: "INTERNAL_ERROR",
    requestId: context.requestId,
  };
  if (context.exposeStack && error instanceof Error) {
    problem.detail = error.message;
    if (error.stack) {
      problem.stack = error.stack;
    }
  }
  return problem;
}

function fromCoded(error: CodedError, context: ProblemContext): Problem {
  const status = STATUS_BY_CODE[error.code] ?? 500;
  const problem: Problem = {
    type: problemType(context.problemBaseUri, error.code),
    title: TITLE_BY_STATUS[status] ?? "Error",
    status,
    detail: status === 500 ? "An unexpected error occurred." : error.message,
    instance: context.instance,
    code: status === 500 ? "INTERNAL_ERROR" : error.code,
    requestId: context.requestId,
  };
  const errors = error.details?.errors;
  if (Array.isArray(errors)) {
    problem.errors = errors.filter(isProblemErrorItem);
  }
  if (context.exposeStack && error.stack && status !== 500) {
    problem.stack = error.stack;
  }
  return problem;
}

function isProblemErrorItem(value: unknown): value is ProblemErrorItem {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { path?: unknown; message?: unknown };
  return (
    typeof candidate.path === "string" && typeof candidate.message === "string"
  );
}

export function problemType(base: string, code: string): string {
  const trimmed = base.replace(/\/$/, "");
  return `${trimmed}/${code.toLowerCase().replaceAll("_", "-")}`;
}

export function isPayloadTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    status?: number;
    statusCode?: number;
    type?: string;
  };
  return (
    candidate.status === 413 ||
    candidate.statusCode === 413 ||
    candidate.type === "entity.too.large"
  );
}

function isJsonSyntaxError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) {
    return false;
  }
  const candidate = error as SyntaxError & { status?: number; type?: string };
  return candidate.status === 400 || candidate.type === "entity.parse.failed";
}

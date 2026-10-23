export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends CodedError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, details);
  }
}

export class InvalidTransitionError extends CodedError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super("INVALID_TRANSITION", `Cannot transition from ${from} to ${to}`);
  }
}

export class VersionConflictError extends CodedError {
  constructor() {
    super(
      "VERSION_CONFLICT",
      "The payment was updated by someone else. Re-read it and retry.",
    );
  }
}

export class PaymentNotFoundError extends CodedError {
  constructor(id: string) {
    super("PAYMENT_NOT_FOUND", `Payment ${id} was not found`);
  }
}

export class IdempotencyMismatchError extends CodedError {
  constructor() {
    super(
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used with a different request body.",
    );
  }
}

/** Raised inside a transaction when the unique key loses a race. The service resolves it. */
export class IdempotencyKeyExistsError extends Error {
  constructor(
    readonly clientId: string,
    readonly key: string,
  ) {
    super("Idempotency key already exists");
    this.name = "IdempotencyKeyExistsError";
  }
}

export class GatewayTimeoutError extends Error {
  constructor() {
    super("Payment gateway timed out");
    this.name = "GatewayTimeoutError";
  }
}

export class GatewayUnavailableError extends Error {
  constructor() {
    super("Payment gateway is unavailable");
    this.name = "GatewayUnavailableError";
  }
}

export class PaymentDeclinedError extends Error {
  constructor() {
    super("Payment was declined");
    this.name = "PaymentDeclinedError";
  }
}

export class UnauthorizedError extends CodedError {
  constructor() {
    super("UNAUTHORIZED", "A valid API key is required");
  }
}

export class PayloadTooLargeError extends CodedError {
  constructor() {
    super("PAYLOAD_TOO_LARGE", "Request body exceeds the configured limit");
  }
}

export class UnsupportedMediaTypeError extends CodedError {
  constructor() {
    super("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
}

export class RateLimitedError extends CodedError {
  constructor() {
    super("RATE_LIMITED", "Too many requests. Try again later.");
  }
}

export class MissingIdempotencyKeyError extends CodedError {
  constructor() {
    super("MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
  }
}

export class NotReadyError extends CodedError {
  constructor(message: string) {
    super("NOT_READY", message);
  }
}

export class RouteNotFoundError extends CodedError {
  constructor(method: string, path: string) {
    super("ROUTE_NOT_FOUND", `No route for ${method} ${path}`);
  }
}

export class StorageCorruptError extends CodedError {
  constructor(filePath: string) {
    super(
      "STORAGE_CORRUPT",
      `Payment store at ${filePath} is corrupt and was left unchanged`,
    );
  }
}

export class StorageUnavailableError extends CodedError {
  constructor(message: string) {
    super("STORAGE_UNAVAILABLE", message);
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

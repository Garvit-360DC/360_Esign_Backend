export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly isOperational = true;
  /** Sent to the client next to the message, for a screen that needs more than words. */
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode = 400, code = "APP_ERROR", details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

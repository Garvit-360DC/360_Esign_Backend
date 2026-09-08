export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly isOperational = true;

  constructor(message: string, statusCode = 400, code = "APP_ERROR") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

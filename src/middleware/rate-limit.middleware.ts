import rateLimit from "express-rate-limit";

export const rateLimitMiddleware = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      message: "Too many requests",
      code: "RATE_LIMITED",
    },
  },
});

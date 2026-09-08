import cors from "cors";
import express from "express";
import helmet from "helmet";
import { errorMiddleware, unknownRoute } from "./middleware/error.middleware";
import { rateLimitMiddleware } from "./middleware/rate-limit.middleware";
import { authRoutes } from "./modules/auth/auth.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { signRequestRoutes } from "./modules/sign-requests/sign-request.routes";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );
  app.use(cors());
  app.use(rateLimitMiddleware);
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.use("/health", healthRoutes);
  app.use("/auth", authRoutes);
  app.use("/sign-requests", signRequestRoutes);

  app.use(unknownRoute);
  app.use(errorMiddleware);

  return app;
}

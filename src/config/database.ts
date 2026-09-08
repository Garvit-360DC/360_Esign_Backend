import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "./logger";

export async function connectDb() {
  await mongoose.connect(env.MONGO_URL);
  logger.info("MongoDB connected");
}

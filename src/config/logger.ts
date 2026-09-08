import winston from "winston";
import { env } from "./env";

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
          let line = `${timestamp} [${level}]: ${message}`;
          if (stack) line += `\n${stack}`;
          if (Object.keys(meta).length) line += ` ${JSON.stringify(meta)}`;
          return line;
        })
      ),
    }),
  ],
});

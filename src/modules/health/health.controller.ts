import type { Request, Response } from "express";
import { sendSuccess } from "../../utils/api-response";
import { getHealth } from "./health.service";

export function get(_req: Request, res: Response) {
  return sendSuccess(res, getHealth());
}

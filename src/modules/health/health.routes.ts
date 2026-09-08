import { Router } from "express";
import { get } from "./health.controller";

const router = Router();

router.get("/", get);

export const healthRoutes = router;

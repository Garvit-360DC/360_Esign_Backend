import { Router } from "express";
import {
  exchangeToken,
  getToken,
  handleCallback,
  refreshJwt,
  refreshToken,
  verifyJwt,
} from "./auth.controller";

/**
 * Mounted at the root so the paths match
 * `360_File_Connector_Node/src/routes/auth.routes.js` exactly — the Word add-in already
 * points at `/auth/token`, `/auth/refresh` and `/auth/refresh-jwt`.
 *
 * The callback is the one exception: it sits at `/sf/auth/callback`, which is what is
 * registered against the connected app. It has no client depending on its path — Salesforce
 * is told where to go by `SF_SERVER_CALLBACK_URI`, which must hold the same value.
 */

const router = Router();

router.post("/auth/token", exchangeToken);
router.post("/auth/refresh", refreshToken);
router.get("/sf/auth/callback", handleCallback);
router.post("/auth/refresh-jwt", refreshJwt);

// used by the console to get the login URL
router.post("/getToken", getToken);
router.get("/verify-jwt", verifyJwt);

export const authRoutes = router;

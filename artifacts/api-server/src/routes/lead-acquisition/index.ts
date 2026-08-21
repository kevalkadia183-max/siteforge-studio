/**
 * Lead Acquisition router — assembles focused sub-routers.
 *
 * Route layout (all under /api, registered without /api prefix):
 *   GET  /lead-acquisition/config              → configRouter
 *   GET  /lead-acquisition/dashboard           → configRouter
 *   GET/POST /leads                            → leadsRouter
 *   POST /leads/import                         → leadsRouter
 *   GET/PATCH /leads/:leadId                   → leadsRouter
 *   POST /leads/:leadId/score                  → leadsRouter
 *   PUT/DELETE /leads/:leadId/suppression      → suppressionRouter
 *   GET/POST /leads/:leadId/prospect-site      → prospectRouter
 *   POST /leads/:leadId/prospect-site/regenerate → prospectRouter
 *   POST/DELETE /leads/:leadId/prospect-site/preview → prospectRouter
 *   POST /leads/:leadId/prospect-site/archive  → prospectRouter
 *   POST /leads/:leadId/prospect-site/convert  → prospectRouter
 */

import { Router, type IRouter } from "express";
import { configRouter } from "./routes-config";
import { leadsRouter } from "./routes-leads";
import { suppressionRouter } from "./suppression";
import { prospectRouter } from "./routes-prospect";
import { outreachRouter } from "./routes-outreach";
import { providersRouter } from "./routes-providers";

const router: IRouter = Router();

router.use(configRouter);
router.use(leadsRouter);
router.use(suppressionRouter);
router.use(prospectRouter);
router.use(outreachRouter);
router.use(providersRouter);

export default router;

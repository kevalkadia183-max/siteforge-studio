import { Router, type IRouter } from "express";
import healthRouter from "./health";
import previewsRouter from "./previews";
import receptionistRouter from "./receptionist";
import gmailRouter from "./receptionist/gmail";
import retellRouter from "./receptionist/retell";
import widgetRouter from "./widget";
import websitesRouter from "./websites";
import leadAcquisitionRouter from "./lead-acquisition";
import { prospectPreviewDeliveryRouter } from "./lead-acquisition/prospect-preview-delivery";

const router: IRouter = Router();

router.use(healthRouter);
router.use(previewsRouter);
router.use(receptionistRouter);
router.use(gmailRouter);
router.use(retellRouter);
router.use(widgetRouter);
router.use(websitesRouter);
router.use(leadAcquisitionRouter);
// Public prospect preview delivery (HMAC-signed, no auth required)
router.use(prospectPreviewDeliveryRouter);

export default router;

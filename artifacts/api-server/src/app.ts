import express, { type ErrorRequestHandler, type Express } from "express";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import { sanitizeRequestUrlForLogs } from "./lib/request-log-sanitize";
import { recordRejectedRetellWebhook } from "./lib/retell-webhook-audit";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: sanitizeRequestUrlForLogs(req.url),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Clerk proxy must be mounted before body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(
  "/api/receptionist/retell/webhook",
  express.raw({ type: "application/json", limit: "4mb" }),
);
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));

// Resolve the publishable key from the incoming request host so the same
// server can serve multiple Clerk custom domains. Falls back to
// CLERK_PUBLISHABLE_KEY when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

const errorHandler: ErrorRequestHandler = async (error, req, res, _next) => {
  const details =
    error && typeof error === "object"
      ? (error as { status?: unknown; statusCode?: unknown; type?: unknown })
      : {};
  const isPayloadTooLarge =
    details.status === 413 ||
    details.statusCode === 413 ||
    details.type === "entity.too.large";

  if (isPayloadTooLarge) {
    const isRetellWebhook =
      req.method === "POST" &&
      req.originalUrl?.split("?")[0] ===
        "/api/receptionist/retell/webhook";
    if (isRetellWebhook) {
      try {
        await recordRejectedRetellWebhook({
          reason: "payload_too_large",
          payloadHash: null,
        });
      } catch (auditError) {
        req.log.error(
          { error: auditError, reason: "payload_too_large" },
          "Failed to persist rejected Retell webhook audit",
        );
      }
    }
    req.log.warn("Rejected oversized API request");
    res.status(413).json({ error: "The request payload is too large." });
    return;
  }

  req.log.error({ error }, "Unhandled API request error");
  res.status(500).json({ error: "An unexpected server error occurred." });
};
app.use(errorHandler);

export default app;

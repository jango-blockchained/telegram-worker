import {
  type EnvWithKV,
  logKvTimestamp,
} from "@jango-blockchained/hoox-shared/kvUtils"; // Import shared function
// KVNamespace, Ai, VectorizeIndex, R2Bucket types are globally available from worker-configuration.d.ts
import {
  Errors,
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import type { AnalyticsEnv } from "@jango-blockchained/hoox-shared/analytics";
import {
  createLogger,
  requireInternalAuth,
  withRequestLog,
} from "@jango-blockchained/hoox-shared/middleware";
import type { InternalAuthEnv } from "@jango-blockchained/hoox-shared/middleware";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import type { ProcessRequestBody } from "@jango-blockchained/hoox-shared/types";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";

import { handleWebhookRequest } from "./handlers/webhook";
import { sendTelegramNotification } from "./logic/telegram";
import {
  generateEmbeddings,
  insertEmbeddings,
  queryEmbeddings,
} from "./logic/rag";
import { handleGetLatestTradeSignalR2 } from "./logic/telegram";

// --- Type Definitions ---

export interface Env extends Cloudflare.Env, AnalyticsEnv, EnvWithKV {
  CONFIG_KV: KVNamespace;
  UPLOADS_BUCKET: R2Bucket;
  VECTORIZE_INDEX: VectorizeIndex;
  AI: Ai;
  ANALYTICS_SERVICE: Fetcher;
}

// Payload structure for incoming requests (both /process and /webhook)
interface NotificationPayload {
  message: string;
  chatId?: string; // Optional: if not provided, use default from TG_CHAT_ID_BINDING
}

// Payload for the legacy /process endpoint
type TelegramProcessRequestBody = ProcessRequestBody<NotificationPayload>;

// --- Constants ---
const ALERT_ENDPOINT = "/alert"; // Internal notification endpoint (replaces legacy /process)
const PROCESS_ENDPOINT = "/process"; // Legacy — redirects to /alert
const WEBHOOK_ENDPOINT = "/webhook"; // Telegram Bot API webhook endpoint

// --- Worker Definition ---

const logger = createLogger({ service: "telegram-worker", module: "router" });

const router = createRouter<Env>();

// Define routes
router.get(
  "/health",
  async (_request: Request, _env: Env, _ctx: ExecutionContext) => {
    return healthCheck({ worker: "telegram-worker" });
  }
);

// POST /alert — internal notification endpoint (requires internal auth)
// Called by: hoox, trade-worker, agent-worker, report-worker, web3-wallet-worker
router.post(
  ALERT_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(logKvTimestamp(env, "CONFIG_KV"));
    return await handleAlertRequest(request, env, ctx);
  }
);

// POST /process — legacy endpoint, redirects to /alert
router.post(
  PROCESS_ENDPOINT,
  async (_request: Request, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(logKvTimestamp(env, "CONFIG_KV"));
    return Response.redirect(
      new URL(ALERT_ENDPOINT, _request.url).toString(),
      308
    );
  }
);

// POST /webhook — Telegram Bot API webhook endpoint
// Receives updates from Telegram for interactive bot commands
router.post(
  WEBHOOK_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(logKvTimestamp(env, "CONFIG_KV"));
    return await handleWebhookRequest(request, env, ctx, logger);
  }
);

export default {
  fetch: withRequestLog<Env>(
    (request: Request, env: Env, ctx: ExecutionContext) => {
      return router.handle(request, env, ctx);
    },
    { service: "telegram-worker", module: "router" }
  ),
};

/**
 * Handles the internal notification request (/alert endpoint).
 * Called by other workers via service binding to send Telegram messages.
 */
async function handleAlertRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  let incomingRequestId = "unknown";

  try {
    const body: TelegramProcessRequestBody = await request.json();
    incomingRequestId = body.requestId || "unknown";

    const authResult = requireInternalAuth(request, env);
    if (authResult) return authResult;

    const result = await sendTelegramNotification(
      body.payload,
      env,
      ctx,
      logger,
      incomingRequestId
    );

    return createJsonResponse({ success: true, result }, 200);
  } catch (error: unknown) {
    const errorMsg = toError(error, "Internal Server Error");
    logger.error(`[${incomingRequestId}] Error in handleProcessRequest:`, {
      error: errorMsg,
    });
    return Errors.internal(errorMsg);
  }
}

// Export helper functions for testing
export {
  generateEmbeddings,
  insertEmbeddings,
  queryEmbeddings,
  handleGetLatestTradeSignalR2,
};

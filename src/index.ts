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

export interface Env extends Cloudflare.Env, AnalyticsEnv {}

// Payload structure for incoming requests (both /process and /webhook)
interface NotificationPayload {
  message: string;
  chatId?: string; // Optional: if not provided, use default from TG_CHAT_ID_BINDING
}

// Payload for the legacy /process endpoint
type TelegramProcessRequestBody = ProcessRequestBody<NotificationPayload>;

// --- Constants ---
const PROCESS_ENDPOINT = "/process"; // Legacy endpoint
const WEBHOOK_ENDPOINT = "/webhook"; // New endpoint for service bindings

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

router.post(
  PROCESS_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(logKvTimestamp(env as unknown as EnvWithKV));
    return await handleProcessRequest(request, env, ctx);
  }
);

router.post(
  WEBHOOK_ENDPOINT,
  async (request: Request, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(logKvTimestamp(env as unknown as EnvWithKV));
    return await handleWebhookRequest(request, env, logger);
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
 * Handles the legacy standardized processing request (/process endpoint).
 */
async function handleProcessRequest(
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

import type { Fetcher } from "@cloudflare/workers-types"; // Import Fetcher if used

// --- Type Definitions ---

interface SecretBinding {
  get: () => Promise<string | null>;
}

// Define Env based on wrangler.toml and potential future bindings
interface Env {
  INTERNAL_KEY_BINDING?: SecretBinding; // For legacy /process auth
  TG_BOT_TOKEN_BINDING: SecretBinding;  // Required
  TG_CHAT_ID_BINDING?: SecretBinding;   // Optional default chat ID

  // Add other bindings/vars if needed
}

// Payload structure for incoming requests (both /process and /webhook)
interface NotificationPayload {
  message: string;
  chatId?: string; // Optional: if not provided, use default from TG_CHAT_ID_BINDING
}

// Payload for the legacy /process endpoint
interface ProcessRequestBody {
  requestId?: string;
  internalAuthKey?: string;
  payload: NotificationPayload; // Nested payload
}

// Standardized response structure
interface StandardResponse {
  success: boolean;
  result?: any;
  error?: string | null;
}

// --- Constants ---
const PROCESS_ENDPOINT = "/process"; // Legacy endpoint
const WEBHOOK_ENDPOINT = "/webhook"; // New endpoint for service bindings

// --- Worker Definition ---
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST") {
      if (url.pathname === PROCESS_ENDPOINT) {
        return await handleProcessRequest(request, env);
      } else if (url.pathname === WEBHOOK_ENDPOINT) {
        return await handleWebhookRequest(request, env);
      }
    }
    return new Response("Not Found", { status: 404 });
  },
};

// --- Helper Functions ---

/**
 * Creates a standard JSON response.
 */
function createJsonResponse(
  body: StandardResponse,
  status: number = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Core logic to send a Telegram message.
 * @param payload The notification details.
 * @param env Environment containing bot token and optional default chat ID.
 * @param requestId Optional request ID for logging.
 * @returns The JSON response from the Telegram API.
 */
async function sendTelegramNotification(
    payload: NotificationPayload,
    env: Env,
    requestId?: string
): Promise<any> {
    const botToken = await env.TG_BOT_TOKEN_BINDING?.get();
    if (!botToken) {
        console.error(`[${requestId}] TG_BOT_TOKEN_BINDING secret not configured.`);
        throw new Error("Telegram bot token not configured.");
    }

    const defaultChatId = await env.TG_CHAT_ID_BINDING?.get();
    const chatId = payload.chatId || defaultChatId;

    if (!chatId) {
        console.error(`[${requestId}] Chat ID missing and default not configured.`);
        throw new Error("Chat ID configuration error");
    }

    const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

    console.log(`[${requestId}] Sending message to chat ID ${chatId}`);

    const response = await fetch(telegramApiUrl, {
        method: "POST",
        headers: {
        "Content-Type": "application/json",
        },
        body: JSON.stringify({
        chat_id: chatId,
        text: payload.message,
        parse_mode: "HTML", // Or "MarkdownV2" or null
        disable_web_page_preview: true,
        }),
    });

    const responseData = await response.json();

    if (!response.ok) {
        console.error(`[${requestId}] Telegram API Error:`, responseData);
        throw new Error(
        `Telegram API request failed (${response.status}): ${responseData.description || "Unknown error"}`
        );
    }

    console.log(`[${requestId}] Telegram API Success Response:`, responseData);
    return responseData;
}


// --- Request Handlers ---

/**
 * Handles POST requests to the /webhook endpoint (from service bindings).
 */
async function handleWebhookRequest(request: Request, env: Env): Promise<Response> {
    const incomingRequestId = request.headers.get("X-Request-ID") || crypto.randomUUID();
    console.log(`Processing Telegram webhook request ID: ${incomingRequestId}`);

    try {
        const payload: NotificationPayload = await request.json();

        if (!payload || !payload.message) {
             console.warn(`[${incomingRequestId}] Missing message in webhook payload.`);
            return createJsonResponse({ success: false, error: "Missing message in payload" }, 400);
        }

        const telegramResult = await sendTelegramNotification(payload, env, incomingRequestId);

        return createJsonResponse({ success: true, result: telegramResult });

    } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error || "Unknown error processing webhook");
        console.error(`[${incomingRequestId}] Error processing webhook:`, errorMsg, error);
        return createJsonResponse({ success: false, error: errorMsg }, 500);
    }
}

/**
 * Handles the legacy standardized processing request (/process endpoint).
 */
async function handleProcessRequest(request: Request, env: Env): Promise<Response> {
  let incomingRequestId = "unknown";

  try {
    const data: ProcessRequestBody = await request.json();
    incomingRequestId = data?.requestId || crypto.randomUUID();
    const internalAuthKey = data?.internalAuthKey;

    console.log(`Processing legacy Telegram request ID: ${incomingRequestId}`);

    // --- Authenticate ---
    const expectedInternalKey = await env.INTERNAL_KEY_BINDING?.get();
    if (!expectedInternalKey) {
      console.error(`[${incomingRequestId}] INTERNAL_KEY_BINDING secret not configured.`);
      return createJsonResponse({ success: false, error: "Service configuration error" }, 500);
    }
    if (!internalAuthKey || internalAuthKey !== expectedInternalKey) {
      console.warn(`[${incomingRequestId}] Authentication failed.`);
      return createJsonResponse({ success: false, error: "Authentication failed" }, 403);
    }

    // --- Process Payload ---
    const payload = data?.payload;
    if (!payload || !payload.message) {
       console.warn(`[${incomingRequestId}] Missing message in legacy payload.`);
      return createJsonResponse({ success: false, error: "Missing message in payload" }, 400);
    }

    // --- Send Notification --- 
    const telegramResult = await sendTelegramNotification(payload, env, incomingRequestId);

    return createJsonResponse({ success: true, result: telegramResult });

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error || "Unknown error processing legacy request");
    console.error(`[${incomingRequestId}] Error processing legacy request:`, errorMsg, error);
    return createJsonResponse({ success: false, error: errorMsg }, 500);
  }
} 
import type { KVNamespace } from "@cloudflare/workers-types"; // Import KVNamespace
import {
  type EnvWithKV,
  logKvTimestamp,
} from "../../../packages/shared/src/kvUtils"; // Import shared function
import type { Ai } from "@cloudflare/ai"; // Import the Ai type
import type { VectorizeIndex } from "@cloudflare/workers-types"; // Import VectorizeIndex type
import type { R2Bucket } from "@cloudflare/workers-types"; // Import R2Bucket type
import {
  Errors,
  createJsonResponse,
  toError,
} from "@jango-blockchained/hoox-shared/errors";
import {
  createLogger,
  withRequestLog,
} from "@jango-blockchained/hoox-shared/middleware";
import { createRouter } from "@jango-blockchained/hoox-shared/router";
import { KVKeys } from "@jango-blockchained/hoox-shared/kvKeys";
import type { ProcessRequestBody } from "@jango-blockchained/hoox-shared/types";
import { trackAnalytics } from "@jango-blockchained/hoox-shared/analytics";
import { healthCheck } from "@jango-blockchained/hoox-shared/health";

// --- Type Definitions ---

interface Env extends Cloudflare.Env {
  [key: string]: unknown;
}

// Payload structure for incoming requests (both /process and /webhook)
interface NotificationPayload {
  message: string;
  chatId?: string; // Optional: if not provided, use default from TG_CHAT_ID_BINDING
}

// Payload for the legacy /process endpoint
type TelegramProcessRequestBody = ProcessRequestBody<NotificationPayload>;

// Standardized response structure - imported from shared types

// Define the structure for metadata stored with embeddings
interface TelegramMessageMetadata {
  messageId: string; // Use Telegram's message ID
  chatId: string;
  senderId?: string; // Optional, might not always be available/needed
  timestamp: string; // ISO 8601 format
  text: string;
}

interface VectorizeMatches {
  matches: Array<{
    id: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
}

type R2ObjectBody = {
  body: ReadableStream<Uint8Array>;
  customMetadata: Record<string, string>;
  httpEtag: string;
  key: string;
  size: number;
};

// --- Constants ---
const PROCESS_ENDPOINT = "/process"; // Legacy endpoint
const WEBHOOK_ENDPOINT = "/webhook"; // New endpoint for service bindings

// --- Worker Definition ---

const logger = createLogger({ service: "telegram-worker", module: "router" });

const router = createRouter<Env>();

// Define routes
router.get(
  "/health",
  async (request: Request, env: Env, ctx: ExecutionContext) => {
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
    return await handleWebhookRequest(request, env);
  }
);

export default {
  fetch: withRequestLog(
    (request: Request, env: Env, ctx: ExecutionContext) => {
      return router.handle(request, env, ctx);
    },
    { service: "telegram-worker", module: "router" }
  ),
};

// --- Helper Functions ---

/**
 * Generates embeddings for the given text using the specified AI model.
 * @param text The text or array of texts to embed.
 * @param env The worker environment containing the AI binding.
 * @returns A promise that resolves to an array of embedding vectors.
 * @throws If the AI binding is not configured or the API call fails.
 */
export async function generateEmbeddings(
  text: string | string[],
  env: Env
): Promise<number[][]> {
  if (!env.AI) {
    logger.error("AI binding is not configured in the environment.");
    throw new Error("AI service not available.");
  }

  try {
    logger.info(`Generating embeddings for input text...`);
    const response: any = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text,
    });

    // Assuming the response structure contains a 'data' field with the embeddings
    if (!response || !response.data || !Array.isArray(response.data)) {
      logger.error(
        "Invalid response structure from AI embedding model:",
        response
      );
      throw new Error("Failed to parse embeddings from AI response.");
    }

    logger.info(`Successfully generated ${response.data.length} embedding(s).`);
    return response.data;
  } catch (error: unknown) {
    const errorMsg = toError(error, "Unknown AI error");
    logger.error("Error generating embeddings", { error: errorMsg });
    throw new Error(`Failed to generate embeddings: ${errorMsg}`, {
      cause: error,
    });
  }
}

/**
 * Inserts embeddings and associated metadata into the Vectorize index.
 * @param vectors An array of embedding vectors (number[][]).
 * @param metadata An array of metadata objects corresponding to each vector.
 * @param env The worker environment containing the Vectorize binding.
 * @throws If the Vectorize binding is not configured or the API call fails.
 */
export async function insertEmbeddings(
  vectors: number[][],
  metadata: TelegramMessageMetadata[],
  env: Env
): Promise<void> {
  if (vectors.length !== metadata.length) {
    throw new Error("Number of vectors must match number of metadata objects.");
  }

  if (!env.VECTORIZE_INDEX) {
    logger.error(
      "VECTORIZE_INDEX binding is not configured in the environment."
    );
    throw new Error("Vectorize service not available.");
  }

  // Prepare data for insertion
  const dataToInsert = vectors.map((vector, index) => ({
    id: metadata[index].messageId, // Use messageId as the vector ID
    values: vector,
    metadata: metadata[index] as any, // Store the whole metadata object
  }));

  if (dataToInsert.length === 0) {
    logger.info("No data to insert into Vectorize.");
    return;
  }

  try {
    logger.info(
      `Inserting ${dataToInsert.length} vector(s) into Vectorize index...`
    );
    const insertResult = await env.VECTORIZE_INDEX.insert(dataToInsert);
    logger.info("Vectorize insertion successful", { result: insertResult });
  } catch (error: unknown) {
    const errorMsg = toError(error, "Unknown Vectorize error");
    logger.error("Error inserting embeddings into Vectorize", {
      error: errorMsg,
    });
    throw new Error(`Failed to insert embeddings: ${errorMsg}`, {
      cause: error,
    });
  }
}

/**
 * Queries the Vectorize index for vectors similar to the query text.
 * @param queryText The text to search for.
 * @param env The worker environment containing AI and Vectorize bindings.
 * @param topK The maximum number of similar vectors to return (default: 3).
 * @returns A promise that resolves to the Vectorize query results.
 * @throws If bindings are not configured or API calls fail.
 */
export async function queryEmbeddings(
  queryText: string,
  env: Env,
  topK: number = 3
): Promise<VectorizeMatches> {
  if (!env.VECTORIZE_INDEX) {
    logger.error("VECTORIZE_INDEX binding is not configured.");
    throw new Error("Vectorize service not available.");
  }
  if (!env.AI) {
    logger.error("AI binding is not configured.");
    throw new Error("AI service not available for query embedding.");
  }

  try {
    // 1. Generate embedding for the query text
    logger.info(`Generating embedding for query: "${queryText}"...`);
    const queryEmbedding = (await generateEmbeddings(queryText, env))[0]; // Expecting a single vector back

    if (!queryEmbedding) {
      throw new Error("Failed to generate embedding for query text.");
    }

    // 2. Query Vectorize
    logger.info(`Querying Vectorize index with topK=${topK}...`);
    const results = await env.VECTORIZE_INDEX.query(queryEmbedding, {
      topK,
      returnMetadata: true,
    });
    logger.info(`Vectorize query found ${results.matches.length} match(es).`);

    return results;
  } catch (error: unknown) {
    const errorMsg = toError(error, "Unknown query error");
    logger.error("Error querying embeddings", { error: errorMsg });
    // Re-throw the error to be handled by the caller
    throw new Error(`Failed to query embeddings: ${errorMsg}`, {
      cause: error,
    });
  }
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
  ctx: ExecutionContext,
  requestId?: string
): Promise<any> {
  const botToken = env.TG_BOT_TOKEN_BINDING;
  if (!botToken) {
    logger.error(`[${requestId}] TG_BOT_TOKEN_BINDING secret not configured.`);
    throw new Error("Telegram bot token not configured.");
  }

  const [botEnabled, defaultChatId, notifyExecution, notifyError] =
    await Promise.all([
      env.CONFIG_KV?.get(KVKeys.KV_BOT_ENABLED).then((v) => v !== "false"),
      env.CONFIG_KV?.get(KVKeys.KV_BOT_DEFAULT_CHAT_ID).then((v) => v || ""),
      env.CONFIG_KV?.get(KVKeys.KV_BOT_NOTIFY_ON_EXECUTION).then(
        (v) => v !== "false"
      ),
      env.CONFIG_KV?.get(KVKeys.KV_BOT_NOTIFY_ON_ERROR).then(
        (v) => v !== "false"
      ),
    ]);

  if (!botEnabled) {
    logger.info(`[${requestId}] Telegram notifications disabled via KV config`);
    return { success: true, skipped: true, reason: "bot disabled" };
  }

  const chatId = payload.chatId || defaultChatId;

  if (!chatId) {
    logger.error(`[${requestId}] Chat ID missing and default not configured.`);
    throw new Error("Chat ID configuration error");
  }

  const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

  logger.info(`[${requestId}] Sending message to chat ID ${chatId}`);

  const response = await fetch(telegramApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: payload.message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const responseData = (await response.json()) as any;

  if (!response.ok) {
    logger.error(`[${requestId}] Telegram API Error:`, responseData);
    throw new Error(
      `Telegram API request failed (${response.status}): ${responseData.description || "Unknown error"}`
    );
  }

  logger.info(`[${requestId}] Telegram API Success Response:`, responseData);

  // Track notification analytics (non-blocking)
  ctx.waitUntil(
    trackAnalytics(env, "/track/notification", {
      data: {
        type: "telegram",
        target: chatId,
        success: response.ok,
      },
    })
  );

  return responseData;
}

// --- Request Handlers ---

/**
 * Fetches the latest trade signal object from R2.
 * @param env Environment containing R2 binding.
 * @returns The latest R2ObjectBody or null if none found or error occurs.
 */
export async function handleGetLatestTradeSignalR2(
  env: Env
): Promise<R2ObjectBody | null> {
  if (!env.UPLOADS_BUCKET) {
    logger.error("R2_BUCKET binding is not configured.");
    return null;
  }

  try {
    logger.info("Listing objects in R2 bucket...");
    // List objects, assuming keys are sortable (e.g., timestamp-based)
    const listed = await env.UPLOADS_BUCKET.list({
      limit: 1, // We only need the latest one
      // You might need a prefix if signals are stored alongside other things
      // prefix: "trade-signals/",
      // Sorting/ordering depends on your key naming convention.
      // R2 list results are lexicographically sorted by key.
      // If keys are like `trade-signal-<timestamp>.json`, the default sort *might* work,
      // otherwise, you might need to list more and sort in the worker.
    });

    if (listed.objects.length === 0) {
      logger.info("No objects found in R2 bucket.");
      return null;
    }

    // Assuming the first object in the default sort is the latest (adjust if needed)
    const latestObject = listed.objects[0];
    logger.info(`Found latest object: ${latestObject.key}`);

    const objectBody = await env.UPLOADS_BUCKET.get(latestObject.key);
    if (objectBody === null) {
      logger.error(
        `Failed to retrieve object body for key: ${latestObject.key}`
      );
      return null;
    }

    logger.info(
      `Successfully retrieved object body for key: ${latestObject.key}`
    );
    return objectBody as any;
  } catch (error: unknown) {
    logger.error("Error fetching latest trade signal from R2", {
      error: toError(error),
    });
    return null;
  }
}

/**
 * Sends a reply message back to the Telegram chat.
 * @param chatId The target chat ID.
 * @param text The message text to send.
 * @param env Environment containing the bot token.
 */
async function sendTelegramReply(
  chatId: string | number,
  text: string,
  env: Env
): Promise<Response> {
  const botToken = env.TG_BOT_TOKEN_BINDING;
  if (!botToken) {
    logger.error("Telegram Bot Token is not configured.");
    return createJsonResponse(
      { success: false, error: "Bot token not configured" },
      500
    );
  }

  const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "MarkdownV2", // Or "HTML", be careful with escaping
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const responseBody = await response.json();

    if (!response.ok) {
      logger.error("Error sending Telegram reply", {
        status: response.status,
        statusText: response.statusText,
        body: responseBody,
      });
      // Don't return the internal error details to the webhook caller
      return createJsonResponse(
        { success: false, error: "Failed to send reply" },
        502
      );
    }

    logger.info("Successfully sent Telegram reply.");
    // Telegram webhook expects a 200 OK even if the reply send had issues downstream.
    // The response here is mainly for the worker's fetch caller, not Telegram itself.
    return createJsonResponse({ success: true, result: responseBody }, 200);
  } catch (error: unknown) {
    logger.error("Network error sending Telegram reply", {
      error: toError(error),
    });
    return createJsonResponse(
      { success: false, error: "Network error sending reply" },
      500
    );
  }
}

/**
 * Handles incoming requests from the Telegram webhook.
 * Parses commands, interacts with services (AI, Vectorize, R2), and sends replies.
 */
async function handleWebhookRequest(
  request: Request,
  env: Env
): Promise<Response> {
  // 1. Security Check
  const secretToken = env.TELEGRAM_SECRET_TOKEN;
  const receivedToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

  if (secretToken && receivedToken !== secretToken) {
    logger.warn("Invalid or missing Telegram secret token received.");
    return new Response("Unauthorized", { status: 401 });
  }

  // 2. Parse Telegram Update
  let update: any;
  try {
    update = await request.json();
    logger.info("Received Telegram update", { update });
  } catch (error: unknown) {
    logger.error("Failed to parse Telegram update JSON", {
      error: toError(error),
    });
    return new Response("Bad Request: Invalid JSON", { status: 400 });
  }

  // Extract message details (simplified, assumes a message exists)
  // Production code needs more robust checking for different update types
  const message = update.message || update.edited_message;
  if (
    !message ||
    !message.text ||
    !message.chat ||
    !message.chat.id ||
    !message.message_id
  ) {
    logger.info(
      "Received update without a usable message/chat context. Skipping."
    );
    // Acknowledge Telegram successfully, even if we don't process it
    return new Response("OK", { status: 200 });
  }

  const chatId = message.chat.id;
  const messageText = message.text.trim();
  const messageId = String(message.message_id);
  const senderId = message.from?.id ? String(message.from.id) : undefined;

  // 3. Command Handling & Processing
  try {
    if (messageText.startsWith("/search ")) {
      const query = messageText.substring(8).trim();
      if (!query) {
        await sendTelegramReply(
          chatId,
          "Please provide a search term after /search.",
          env
        );
      } else {
        logger.info(`Processing /search command with query: "${query}"`);
        const searchResults = await queryEmbeddings(query, env, 5); // Get top 5 results

        let replyText = `Found ${searchResults.matches.length} results for "_${query}_":\n\n`;
        if (searchResults.matches.length > 0) {
          searchResults.matches.forEach((match, index) => {
            // Assuming metadata contains the original text
            const originalText =
              (match.metadata?.text as string) || "(No text found)";
            // Escape Telegram MarkdownV2 special characters: _*[]()~`>#+-=|{}.!
            const escapedText = originalText.replace(
              /([_*[\\]()~`>#+\\-=|{}.!])/g,
              "\\$1"
            );
            replyText += `${index + 1}. (${match.score.toFixed(3)}) ${escapedText}\n`;
          });
        } else {
          replyText = `No results found for "_${query}_."`;
        }
        await sendTelegramReply(chatId, replyText, env);
      }
    } else if (messageText === "/latest") {
      logger.info("Processing /latest command...");
      const latestSignalObject = await handleGetLatestTradeSignalR2(env);
      if (latestSignalObject) {
        try {
          const text = await new Response(latestSignalObject.body).text();
          const signalData = JSON.parse(text);
          const formattedSignal = JSON.stringify(signalData, null, 2).replace(
            /([_*[\\]()~`>#+\\-=|{}.!])/g,
            "\\$1"
          );
          await sendTelegramReply(
            chatId,
            `*Latest Trade Signal:*\n\`\`\`json\n${formattedSignal}\n\`\`\``,
            env
          );
        } catch (parseError: unknown) {
          logger.error("Failed to parse latest signal JSON", {
            error: toError(parseError),
          });
          await sendTelegramReply(
            chatId,
            "Error: Could not read the latest signal data.",
            env
          );
        }
      } else {
        await sendTelegramReply(
          chatId,
          "Could not find any recent trade signals.",
          env
        );
      }
    } else if (messageText.startsWith("/ask ")) {
      const question = messageText.substring(5).trim();
      if (!question) {
        await sendTelegramReply(
          chatId,
          "Please provide a question after /ask\\.",
          env
        );
      } else {
        logger.info(`Processing /ask command with question: "${question}"`);
        await sendTelegramReply(
          chatId,
          `_Searching message history for context related to "${question}".`,
          env
        ); // Send feedback

        let searchResults: VectorizeMatches | null = null;
        try {
          searchResults = await queryEmbeddings(question, env, 5); // Get top 5 contexts
        } catch (vectorError: unknown) {
          logger.error("Error querying Vectorize during /ask", {
            error: toError(vectorError),
          });
          await sendTelegramReply(
            chatId,
            "Sorry, I encountered an error searching the message history\\. Please try again later\\.",
            env
          );
          // Exit this command handler
          return new Response("OK", { status: 200 });
        }

        const contextTexts = searchResults.matches
          .map((match) => match.metadata?.text as string)
          .filter((text) => !!text);

        if (contextTexts.length === 0) {
          await sendTelegramReply(
            chatId,
            `Couldn't find relevant context for "${question}". Try asking differently or indexing more messages.`,
            env
          );
        } else {
          // Limit context length to avoid exceeding token limits (e.g., ~3000 chars)
          const MAX_CONTEXT_LENGTH = 3000;
          let currentLength = 0;
          const limitedContext: string[] = [];
          for (const text of contextTexts) {
            if (currentLength + text.length < MAX_CONTEXT_LENGTH) {
              limitedContext.push(text);
              currentLength += text.length;
            } else {
              break; // Stop adding context once limit is reached
            }
          }

          const contextString = limitedContext
            .map((text, i) => `Context ${i + 1}: ${text}`)
            .join("\\n-----\\n"); // Separator for clarity

          // Refined System Prompt
          const systemPrompt =
            "You are a helpful assistant\\. Answer the user's question based *ONLY* on the provided context snippets from previous messages\\. If the context does not contain the answer, clearly state that you cannot answer based on the provided information\\. Do not add any information not present in the context\\.";
          const userPrompt = `CONTEXT:\n${contextString}\n\nQUESTION: ${question}`;

          await sendTelegramReply(
            chatId,
            `_Found ${limitedContext.length} relevant message snippets\\! Asking the AI\\.\\.\\._`,
            env
          ); // Send feedback
          logger.info(
            `Sending RAG prompt to AI (Context length: ${currentLength} chars):\nSystem: ${systemPrompt}\nUser: ${userPrompt}`
          );

          let aiResponse: any;
          try {
            aiResponse = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
            });
          } catch (aiError: unknown) {
            logger.error("Error calling AI during /ask", {
              error: toError(aiError),
            });
            await sendTelegramReply(
              chatId,
              "Sorry, I encountered an error asking the AI\\. Please try again later\\.",
              env
            );
            // Exit this command handler
            return new Response("OK", { status: 200 });
          }

          const rawAnswer =
            aiResponse.response ||
            "Sorry, I couldn't generate an answer based on the context\\.";
          // Escape Telegram MarkdownV2 special characters
          const escapedAnswer = rawAnswer.replace(
            /([_*[\\]()~`>#+\\-=|{}.!])/g,
            "\\\\$1"
          );
          const finalAnswer = `_Based on message history:_\\n${escapedAnswer}`; // Add attribution

          await sendTelegramReply(chatId, finalAnswer, env);
        }
      }
    } else {
      // Default: Treat as text to be indexed
      logger.info(`Indexing message: "${messageText}"`);
      const embeddings = await generateEmbeddings(messageText, env);
      const metadata: TelegramMessageMetadata = {
        messageId: messageId,
        chatId: String(chatId),
        senderId: senderId,
        timestamp: message.date
          ? new Date(message.date * 1000).toISOString()
          : new Date().toISOString(),
        text: messageText,
      };
      await insertEmbeddings(embeddings, [metadata], env);
      // Optional: Send an acknowledgment back?
      // await sendTelegramReply(chatId, "Message indexed.", env);
    }

    // Respond OK to Telegram webhook immediately after queuing the reply/processing
    return new Response("OK", { status: 200 });
  } catch (error: unknown) {
    logger.error("Error processing Telegram message", {
      error: toError(error),
    });
    // Try to send an error message back to the user if possible
    try {
      await sendTelegramReply(
        chatId || "unknown_chat",
        `An internal error occurred while processing your request.`,
        env
      );
    } catch (sendError: unknown) {
      logger.error("Failed to send error notification to user", {
        error: toError(sendError),
      });
    }
    // Still return OK to Telegram to prevent retries for processing errors
    return new Response("OK", { status: 200 });
  }
}

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
    const data: TelegramProcessRequestBody = await request.json();
    incomingRequestId = data?.requestId || crypto.randomUUID();
    const internalAuthKey = data?.internalAuthKey;

    logger.info(`Processing legacy Telegram request ID: ${incomingRequestId}`);

    // --- Authenticate ---
    const expectedInternalKey = env.INTERNAL_KEY_BINDING;
    if (!expectedInternalKey) {
      logger.error(
        `[${incomingRequestId}] INTERNAL_KEY_BINDING secret not configured.`
      );
      return createJsonResponse(
        { success: false, error: "Service configuration error" },
        500
      );
    }
    if (!internalAuthKey || internalAuthKey !== expectedInternalKey) {
      logger.warn(`[${incomingRequestId}] Authentication failed.`);
      return createJsonResponse(
        { success: false, error: "Authentication failed" },
        401
      );
    }

    // --- Process ---
    const payload = data.payload;
    if (!payload || !payload.message) {
      logger.warn(
        `[${incomingRequestId}] Missing message in process request payload.`
      );
      return createJsonResponse(
        { success: false, error: "Missing message in payload" },
        400
      );
    }

    const telegramResult = await sendTelegramNotification(
      payload,
      env,
      ctx,
      incomingRequestId
    );

    return createJsonResponse({ success: true, result: telegramResult });
  } catch (error: unknown) {
    const errorMsg = toError(error, "Unknown error processing request");
    logger.error(`[${incomingRequestId}] Error processing request`, {
      error: errorMsg,
    });
    return createJsonResponse({ success: false, error: errorMsg }, 500);
  }
}

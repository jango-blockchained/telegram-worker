import type { Fetcher } from "@cloudflare/workers-types"; // Import Fetcher if used
import type { KVNamespace } from "@cloudflare/workers-types"; // Import KVNamespace
import { type EnvWithKV } from "@/utils/kvUtils"; // Import shared function and Env type
import type { Ai } from '@cloudflare/ai'; // Import the Ai type
import type { VectorizeIndex } from '@cloudflare/workers-types'; // Import VectorizeIndex type

// --- Type Definitions ---

interface SecretBinding {
  get: () => Promise<string | null>;
}

// Define Env based on wrangler.toml and potential future bindings
interface Env extends EnvWithKV {
  INTERNAL_KEY_BINDING?: SecretBinding; // For legacy /process auth
  TG_BOT_TOKEN_BINDING: SecretBinding;  // Required
  TG_CHAT_ID_BINDING?: SecretBinding;   // Optional default chat ID
  AI: Ai; // Add the AI binding
  VECTORIZE_INDEX: VectorizeIndex; // Add the Vectorize binding

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

// Define the structure for metadata stored with embeddings
interface TelegramMessageMetadata {
  messageId: string; // Use Telegram's message ID
  chatId: string;
  senderId?: string; // Optional, might not always be available/needed
  timestamp: string; // ISO 8601 format
  text: string;
}

// --- Constants ---
const PROCESS_ENDPOINT = "/process"; // Legacy endpoint
const WEBHOOK_ENDPOINT = "/webhook"; // New endpoint for service bindings

// --- Worker Definition ---
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Call the shared KV logging function (Consider moving this inside specific handlers if needed)
    // await logKvTimestamp(env); // Moved to only run on POST for now

    // --- Add temporary GET endpoint for testing Vectorize ---
    if (request.method === "GET" && url.pathname === "/test-vectorize") {
      // Ensure this endpoint is removed or secured before production!
      console.warn("Executing temporary /test-vectorize endpoint...");
      const query = url.searchParams.get("q");
      if (!query) {
          return new Response('Missing query parameter "q"', { status: 400 });
      }
      return await handleVectorizeTest(query, env);
    }
    // --- End temporary test endpoint ---

    if (request.method === "POST") {
      // Moved KV logging here as it likely only matters for POST requests
      await logKvTimestamp(env);

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
 * Generates embeddings for the given text using the specified AI model.
 * @param text The text or array of texts to embed.
 * @param env The worker environment containing the AI binding.
 * @returns A promise that resolves to an array of embedding vectors.
 * @throws If the AI binding is not configured or the API call fails.
 */
async function generateEmbeddings(text: string | string[], env: Env): Promise<number[][]> {
  if (!env.AI) {
    console.error("AI binding is not configured in the environment.");
    throw new Error("AI service not available.");
  }

  try {
    console.log(`Generating embeddings for input text...`);
    const response: any = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text });

    // Assuming the response structure contains a 'data' field with the embeddings
    if (!response || !response.data || !Array.isArray(response.data)) {
      console.error("Invalid response structure from AI embedding model:", response);
      throw new Error("Failed to parse embeddings from AI response.");
    }

    console.log(`Successfully generated ${response.data.length} embedding(s).`);
    return response.data;

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error || "Unknown AI error");
    console.error("Error generating embeddings:", errorMsg, error);
    throw new Error(`Failed to generate embeddings: ${errorMsg}`);
  }
}

/**
 * Inserts embeddings and associated metadata into the Vectorize index.
 * @param vectors An array of embedding vectors (number[][]).
 * @param metadata An array of metadata objects corresponding to each vector.
 * @param env The worker environment containing the Vectorize binding.
 * @throws If the Vectorize binding is not configured or the API call fails.
 */
async function insertEmbeddings(
  vectors: number[][],
  metadata: TelegramMessageMetadata[],
  env: Env
): Promise<void> {
  if (vectors.length !== metadata.length) {
    throw new Error("Number of vectors must match number of metadata objects.");
  }

  if (!env.VECTORIZE_INDEX) {
    console.error("VECTORIZE_INDEX binding is not configured in the environment.");
    throw new Error("Vectorize service not available.");
  }

  // Prepare data for insertion
  const dataToInsert = vectors.map((vector, index) => ({
    id: metadata[index].messageId, // Use messageId as the vector ID
    values: vector,
    metadata: metadata[index], // Store the whole metadata object
  }));

  if (dataToInsert.length === 0) {
    console.log("No data to insert into Vectorize.");
    return;
  }

  try {
    console.log(`Inserting ${dataToInsert.length} vector(s) into Vectorize index...`);
    const insertResult = await env.VECTORIZE_INDEX.insert(dataToInsert);
    console.log("Vectorize insertion successful:", insertResult);
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error || "Unknown Vectorize error");
    console.error("Error inserting embeddings into Vectorize:", errorMsg, error);
    throw new Error(`Failed to insert embeddings: ${errorMsg}`);
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
async function queryEmbeddings(
  queryText: string,
  env: Env,
  topK: number = 3
): Promise<VectorizeMatches> {
  if (!env.VECTORIZE_INDEX) {
    console.error("VECTORIZE_INDEX binding is not configured.");
    throw new Error("Vectorize service not available.");
  }
  if (!env.AI) {
    console.error("AI binding is not configured.");
    throw new Error("AI service not available for query embedding.");
  }

  try {
    // 1. Generate embedding for the query text
    console.log(`Generating embedding for query: "${queryText}"...`);
    const queryEmbedding = (await generateEmbeddings(queryText, env))[0]; // Expecting a single vector back

    if (!queryEmbedding) {
        throw new Error("Failed to generate embedding for query text.");
    }

    // 2. Query Vectorize
    console.log(`Querying Vectorize index with topK=${topK}...`);
    const results = await env.VECTORIZE_INDEX.query(queryEmbedding, { topK, returnMetadata: true });
    console.log(`Vectorize query found ${results.matches.length} match(es).`);

    return results;

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error || "Unknown query error");
    console.error("Error querying embeddings:", errorMsg, error);
    // Re-throw the error to be handled by the caller
    throw new Error(`Failed to query embeddings: ${errorMsg}`);
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
      return createJsonResponse({ success: false, error: "Authentication failed" }, 401);
    }

    // --- Process ---
    const payload = data.payload;
    if (!payload || !payload.message) {
      console.warn(`[${incomingRequestId}] Missing message in process request payload.`);
      return createJsonResponse({ success: false, error: "Missing message in payload" }, 400);
    }

    const telegramResult = await sendTelegramNotification(payload, env, incomingRequestId);

    return createJsonResponse({ success: true, result: telegramResult });

  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error || "Unknown error processing request");
    console.error(`[${incomingRequestId}] Error processing request:`, errorMsg, error);
    return createJsonResponse({ success: false, error: errorMsg }, 500);
  }
}

/**
 * Temporary handler for testing Vectorize functionality.
 * REMOVE OR SECURE BEFORE PRODUCTION.
 */
async function handleVectorizeTest(query: string, env: Env): Promise<Response> {
    const testChatId = "test-chat-001";
    const sampleMessages: Omit<TelegramMessageMetadata, 'messageId' | 'timestamp'>[] = [
        { chatId: testChatId, senderId: "user1", text: "Cloudflare Workers provide a serverless execution environment." },
        { chatId: testChatId, senderId: "user2", text: "Vectorize is Cloudflare's vector database service." },
        { chatId: testChatId, senderId: "user1", text: "You can use Workers AI to generate embeddings." },
        { chatId: testChatId, senderId: "user3", text: "How do I query the vector database?" },
    ];

    const results: any = {};
    const timestamp = new Date().toISOString();

    try {
        // 1. Prepare data and generate embeddings for sample messages
        const textsToEmbed = sampleMessages.map(msg => msg.text);
        const metadataList: TelegramMessageMetadata[] = sampleMessages.map((msg, index) => ({
            ...msg,
            messageId: `${testChatId}-msg-${Date.now()}-${index}`, // Simple unique ID for testing
            timestamp: timestamp,
        }));

        results.embeddingGenerationInput = textsToEmbed;
        const vectors = await generateEmbeddings(textsToEmbed, env);
        results.generatedVectorsCount = vectors.length;

        // 2. Insert embeddings
        await insertEmbeddings(vectors, metadataList, env);
        results.insertionComplete = true;
        results.insertedMetadata = metadataList;

        // 3. Query embeddings
        results.queryText = query;
        const queryResults = await queryEmbeddings(query, env, 3); // Get top 3 matches
        results.queryResults = queryResults;

        return createJsonResponse({ success: true, result: results }, 200);

    } catch (error: unknown) {
        console.error("Error during Vectorize test:", error);
        const errorMsg = error instanceof Error ? error.message : String(error || "Vectorize test failed");
         results.error = errorMsg; // Add error details to results
        return createJsonResponse({ success: false, error: errorMsg, result: results }, 500);
    }
}
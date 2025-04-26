// telegram-worker/src/index.js - Sends Telegram messages, expects standardized input via /process.

// Standard endpoint path
const PROCESS_ENDPOINT = "/process";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === PROCESS_ENDPOINT && request.method === "POST") {
      return await handleProcessRequest(request, env);
    }
    return new Response("Not Found", { status: 404 });
  },
};

// Define SecretBinding structure for clarity (not enforced in JS)
/**
 * @typedef {object} SecretBinding
 * @property {() => Promise<string | null>} get
 */

/**
 * @typedef {object} Env
 * @property {SecretBinding} [INTERNAL_KEY_BINDING] // For internal auth (expects WEBHOOK_INTERNAL_KEY)
 * @property {SecretBinding} [TG_BOT_TOKEN_BINDING]
 * @property {SecretBinding} [TG_CHAT_ID_BINDING]
 */

/**
 * Handles the standardized processing request for sending Telegram messages.
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
async function handleProcessRequest(request, env) {
  let incomingRequestId = "unknown"; // Default for logging if parsing fails

  try {
    // --- Parse and Authenticate Standardized Request ---
    const data = await request.json();
    incomingRequestId = data?.requestId;
    const internalAuthKey = data?.internalAuthKey;

    console.log(`Processing Telegram request ID: ${incomingRequestId}`);

    const expectedInternalKey = await env.INTERNAL_KEY_BINDING?.get();

    if (!expectedInternalKey) {
      console.error(
        "INTERNAL_KEY_BINDING secret not configured or accessible."
      );
      return new Response(
        JSON.stringify({
          success: false,
          error: "Service configuration error",
          result: null,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!internalAuthKey || internalAuthKey !== expectedInternalKey) {
      console.warn(
        `Authentication failed for request ID: ${incomingRequestId}`
      );
      return new Response(
        JSON.stringify({
          success: false,
          error: "Authentication failed",
          result: null,
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    // --- Process Telegram Payload ---
    const payload = data?.payload;

    if (!payload) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing payload in request",
          result: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { message, chatId: payloadChatId } = payload;

    if (!message) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing message in payload",
          result: null,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Determine chat ID: use from payload if present, otherwise fallback to default secret
    const defaultChatId = await env.TG_CHAT_ID_BINDING?.get();
    const chatId = payloadChatId || defaultChatId;

    if (!chatId) {
      console.error(
        `Chat ID not provided in payload for request ${incomingRequestId}, and default TG_CHAT_ID_BINDING not configured.`
      );
      return new Response(
        JSON.stringify({
          success: false,
          error: "Chat ID configuration error",
          result: null,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // --- Send Telegram Message ---
    console.log(
      `Sending message for request ${incomingRequestId} to chat ID ${chatId}`
    );
    const telegramResult = await sendTelegramMessage(chatId, message, env);

    // --- Return Standardized Success Response ---
    return new Response(
      JSON.stringify({
        success: true,
        result: telegramResult, // Include Telegram API response as result
        error: null,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    // --- Catch All / Unexpected Errors ---
    console.error(
      `Error processing Telegram request ${incomingRequestId}:`,
      error
    );
    return new Response(
      JSON.stringify({
        success: false,
        error:
          error.message || "Unknown error occurred sending Telegram message",
        result: null,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

/**
 * Sends a message via the Telegram Bot API.
 * @param {string} chatId Target chat ID.
 * @param {string} message Message text.
 * @param {Env} env Environment containing bot token secret.
 * @returns {Promise<object>} The JSON response from the Telegram API.
 */
async function sendTelegramMessage(chatId, message, env) {
  const botToken = await env.TG_BOT_TOKEN_BINDING?.get();
  if (!botToken) {
    console.error("TG_BOT_TOKEN_BINDING secret not configured or accessible.");
    throw new Error("Telegram bot token not configured.");
  }

  const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await fetch(telegramApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML", // Keep consistent parse mode
      disable_web_page_preview: true, // Keep consistent preview setting
    }),
  });

  const responseData = await response.json(); // Always try to parse JSON

  if (!response.ok) {
    console.error("Telegram API Error:", responseData);
    throw new Error(
      `Telegram API request failed with status ${response.status}: ${responseData.description || "Unknown error"}`
    );
  }

  console.log("Telegram API Success Response:", responseData);
  return responseData; // Return the successful JSON response
}

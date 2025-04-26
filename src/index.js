// telegram-worker/src/index.js - Only accepts requests from the webhook receiver

// ES Module format requires a default export
export default {
  async fetch(request, env) {
    return await handleRequest(request, env);
  },
};

async function handleRequest(request, env) {
  // Verify internal service authentication
  const internalKeyHeader = request.headers.get("X-Internal-Key");
  const requestId = request.headers.get("X-Request-ID");

  const expectedInternalKey = await env.INTERNAL_KEY_BINDING?.get();

  if (!expectedInternalKey) {
    console.error("INTERNAL_KEY_BINDING binding not configured or accessible.");
    return new Response(
      JSON.stringify({ success: false, error: "Service configuration error" }),
      { status: 500 }
    );
  }

  if (
    !internalKeyHeader ||
    internalKeyHeader !== expectedInternalKey ||
    !requestId
  ) {
    console.warn("Unauthorized attempt blocked.");
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      { status: 403 }
    );
  }

  try {
    const data = await request.json();
    // Get default chat ID from secret binding
    const defaultChatId = await env.TG_CHAT_ID_BINDING?.get();
    const chatId = data.chatId || defaultChatId;
    const message = data.message;

    if (!chatId) {
      console.error(
        "Chat ID not provided in request and TG_CHAT_ID_BINDING binding not configured or accessible."
      );
      return new Response(
        JSON.stringify({
          success: false,
          error: "Chat ID configuration error",
        }),
        { status: 500 }
      );
    }

    if (!message) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing message parameter",
        }),
        { status: 400 }
      );
    }

    // Send Telegram message
    const telegramResponse = await sendTelegramMessage(chatId, message, env);

    return new Response(
      JSON.stringify({
        success: true,
        requestId,
        telegramResponse,
      })
    );
  } catch (error) {
    console.error("Error sending Telegram message:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Unknown error occurred",
      }),
      { status: 500 }
    );
  }
}

async function sendTelegramMessage(chatId, message, env) {
  const botToken = await env.TG_BOT_TOKEN_BINDING?.get();
  if (!botToken) {
    console.error("TG_BOT_TOKEN_BINDING binding not configured or accessible.");
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
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telegram API error: ${error}`);
  }

  return response.json();
}

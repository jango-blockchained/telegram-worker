# Telegram Worker

A Cloudflare Worker service that sends Telegram messages, typically triggered by the `webhook-receiver`. This worker accepts requests via the standardized `/process` endpoint.

## Features

- Sends formatted messages (HTML) to specified Telegram chats.
- Secure authentication via shared internal key with `webhook-receiver`.
- Uses default chat ID from secrets if not provided in the request.

## Prerequisites

- Node.js >= 16
- Bun (or npm/yarn)
- Wrangler CLI
- Cloudflare Workers account
- Telegram Bot Token (obtained from @BotFather).

## Setup

1.  Install dependencies:
    ```bash
    bun install
    ```
2.  Set your Cloudflare account ID in `wrangler.toml`.
3.  Configure Secrets (via Cloudflare dashboard Secrets Store or `wrangler secret put`):
    *   `WEBHOOK_INTERNAL_KEY`: The **shared** secret key used for authentication with the `webhook-receiver`. Bind this to `INTERNAL_KEY_BINDING` in `wrangler.toml`.
    *   `TELEGRAM_BOT_TOKEN_MAIN`: Your Telegram Bot Token. Bind this to `TG_BOT_TOKEN_BINDING`.
    *   `TELEGRAM_CHAT_ID_DEFAULT`: The default Telegram Chat ID to send messages to if none is specified in the request payload. Bind this to `TG_CHAT_ID_BINDING`.
4.  For local development, create a `.dev.vars` file and define the secrets:
    ```.dev.vars
    # Mock secret bindings for local dev:
    INTERNAL_KEY_BINDING="your_shared_internal_secret"
    TG_BOT_TOKEN_BINDING="your_telegram_bot_token"
    TG_CHAT_ID_BINDING="your_default_telegram_chat_id"
    ```

## Development

Run locally (e.g., on port 8790):
```bash
bun run dev --port 8790
```

Deploy:
```bash
bun run deploy
```

## API Interface

This worker **only** accepts requests from the `webhook-receiver` (or another authenticated internal service) on the `/process` endpoint.

- **Method:** `POST`
- **Endpoint:** `/process`
- **Content-Type:** `application/json`
- **Expected Request Body:**
  ```json
  {
    "requestId": "<uuid_from_receiver>",
    "internalAuthKey": "YOUR_INTERNAL_SHARED_SECRET", // Validated against INTERNAL_KEY_BINDING
    "payload": {
      // --- Telegram-specific payload fields below ---
      "message": "<b>Trade Alert!</b>\nSymbol: <code>BTCUSDT</code>\nAction: LONG", // Required (HTML formatting supported)
      "chatId": "123456789"  // Optional (Target chat ID. If omitted, uses default from TG_CHAT_ID_BINDING)
    }
  }
  ```

- **Response Format:**

  **Success:**
  ```json
  {
    "success": true,
    "result": { /* Raw JSON response from Telegram Bot API's sendMessage method */ },
    "error": null
  }
  ```

  **Error:**
  ```json
  {
    "success": false,
    "result": null,
    "error": "<Error message describing the failure (e.g., Authentication failed, Missing message in payload, Telegram API request failed: ...)>"
  }
  ```

## Message Formatting

The worker sends messages with `parse_mode` set to `HTML`. You can include HTML tags like `<b>`, `<i>`, `<code>`, `<pre>`, `<a>` in the `message` field of the payload.

## Security

- All requests *must* be received on the `/process` endpoint.
- Requests *must* include a valid `internalAuthKey` in the body, matching the `WEBHOOK_INTERNAL_KEY` secret.
- The Telegram Bot Token is stored securely using Cloudflare Workers Secrets.

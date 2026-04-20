# Telegram Worker

**Last Updated:** April 2026

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare®%20Edge%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/) [![Build Status](https://img.shields.io/badge/Build-TODO-lightgrey?style=for-the-badge)](https://github.com/jango-blockchained/hoox-setup/actions) 

**[Main Repository](https://github.com/jango-blockchained/hoox-setup)** 

A Cloudflare® Worker service that handles interactions with the Telegram Bot API. It can send messages, process incoming commands (via webhook or polling), and potentially leverage other Cloudflare® services like R2, AI, and Vectorize.

## Features

- Sends formatted messages (HTML/Markdown) to specified Telegram chats.
- Can be configured to receive and process incoming commands (e.g., `/ask`, `/search`).
- Secure authentication via shared internal key when receiving requests from other workers (e.g., `webhook-receiver`).
- Secure authentication for incoming Telegram webhooks using a secret URL path.
- Potential integration with:
  - **R2:** Storing/retrieving user uploads or generated files (`UPLOADS_BUCKET`).
  - **Workers AI:** Processing commands, generating responses, RAG (`AI` binding).
  - **Vectorize:** Storing embeddings for RAG/semantic search (`VECTORIZE_INDEX`).
  - **KV:** Storing user preferences or configuration (`CONFIG_KV`).

## Prerequisites

- Node.js >= 16
- Bun
- Wrangler CLI
- Cloudflare® Workers account
- Telegram Bot Token (obtained from @BotFather).

## Setup

1.  Install dependencies:
    ```bash
    bun install
    ```
2.  Set your Cloudflare® account ID in `wrangler.jsonc`.
3.  Configure Secrets (via Cloudflare® dashboard Secrets Store or `wrangler secret put`):
    - `INTERNAL_KEY_BINDING`: The **shared** secret key used for authentication with other internal workers.
    - `TELEGRAM_BOT_TOKEN`: Your Telegram Bot Token.
    - `TELEGRAM_CHAT_ID_DEFAULT`: The default Telegram Chat ID for outbound messages if none is specified.
    - `TELEGRAM_WEBHOOK_SECRET`: A secure, random string used to authenticate incoming webhook requests from Telegram.
4.  Update `wrangler.jsonc` with appropriate bindings and variables. Example:
    ```jsonc
    {
      "name": "telegram-worker",
      "main": "src/index.ts",
      "compatibility_date": "2025-03-07",
      "compatibility_flags": ["nodejs_compat"],
      "account_id": "YOUR_CLOUDFLARE_ACCOUNT_ID",
      "secrets": [
        "INTERNAL_KEY_BINDING",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_CHAT_ID_DEFAULT",
        "TELEGRAM_WEBHOOK_SECRET"
      ],
      "kv_namespaces": [
        // Example: If using KV for config
        { "binding": "CONFIG_KV", "id": "...", "preview_id": "..." }
      ],
      "r2_buckets": [
        // Example: If storing user uploads
        { "binding": "UPLOADS_BUCKET", "bucket_name": "user-uploads" }
      ],
      "vectorize": [
        // Example: If using RAG
        { "binding": "VECTORIZE_INDEX", "index_name": "my-rag-index" }
      ],
      "ai": {
        // Example: If using Workers AI
        "binding": "AI"
      },
      "observability": {
         "enabled": true,
         "head_sampling_rate": 1
       }
    }
    ```
5.  Update the corresponding `worker-configuration.d.ts` file.
6.  Set the Telegram webhook (replace `<WORKER_URL>` and `<SECRET_PATH>`):
    ```bash
    curl "https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook?url=<WORKER_URL>/telegram/<TELEGRAM_WEBHOOK_SECRET>"
    ```
    *   `<WORKER_URL>` is the deployed URL of this worker.
    *   `<TELEGRAM_WEBHOOK_SECRET>` is the value you set for the secret.
    *   Ensure your worker code handles requests at the `/telegram/<TELEGRAM_WEBHOOK_SECRET>` path.
7.  For local development, create a `.dev.vars` file and define the secrets/variables:
    ```.dev.vars
    # Mock secrets for local dev:
    INTERNAL_KEY_BINDING="your_shared_internal_secret"
    TELEGRAM_BOT_TOKEN="your_telegram_bot_token"
    TELEGRAM_CHAT_ID_DEFAULT="your_default_telegram_chat_id"
    TELEGRAM_WEBHOOK_SECRET="your_local_webhook_secret"
    # Add mock bindings for KV, R2 etc. if needed locally
    ```

## Development

Run locally:

```bash
bun run dev
```
*Note: Receiving Telegram webhooks locally requires a tunneling service like `cloudflared tunnel`.* 

Deploy:

```bash
bun run deploy
# Remember to set the webhook after deployment if the URL changes
```

## API Interface

### 1. Internal Processing Request (`/process`)

This worker accepts requests from authenticated internal services (like `webhook-receiver`) on the `/process` endpoint, typically for sending notifications.

- **Method:** `POST`
- **Endpoint:** `/process`
- **Content-Type:** `application/json`
- **Expected Request Body:**

  ```json
  {
    "requestId": "<uuid_from_caller>",
    "internalAuthKey": "YOUR_INTERNAL_SHARED_SECRET", // Validated against INTERNAL_KEY_BINDING
    "payload": {
      // --- Telegram-specific payload fields below ---
      "message": "<b>Trade Alert!</b>\nSymbol: <code>BTCUSDT</code>\nAction: LONG", // Required (HTML/Markdown formatting supported based on parse_mode)
      "chatId": "123456789", // Optional (Target chat ID. If omitted, uses default from TELEGRAM_CHAT_ID_DEFAULT)
      "parseMode": "HTML" // Optional (Defaults to HTML, can be MarkdownV2)
    }
  }
  ```

- **Response Format (from `/process`):**

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
    "error": "<Error message>"
  }
  ```

### 2. Telegram Webhook (`/telegram/<TELEGRAM_WEBHOOK_SECRET>`)

Handles incoming updates (messages, commands) from Telegram.

- **Method:** `POST`
- **Endpoint:** `/telegram/<TELEGRAM_WEBHOOK_SECRET>`
- **Authentication:** Relies on the secret path segment matching the `TELEGRAM_WEBHOOK_SECRET` configured.
- **Expected Request Body:** Standard Telegram `Update` object.
- **Response:** Typically responds with `200 OK` immediately to acknowledge receipt. Processing happens asynchronously.

## Message Formatting

The worker typically defaults to sending messages with `parse_mode` set to `HTML`. You can include HTML tags like `<b>`, `<i>`, `<code>`, `<pre>`, `<a>` in the `message` field. `MarkdownV2` can also be specified.

## Security

- Internal requests to `/process` _must_ include a valid `internalAuthKey`.
- Incoming Telegram webhooks are authenticated using the secret path segment (`TELEGRAM_WEBHOOK_SECRET`).
- The Telegram Bot Token and other secrets are stored securely using Cloudflare® Workers Secrets.


---

*Cloudflare® and the Cloudflare logo are trademarks and/or registered trademarks of Cloudflare, Inc. in the United States and other jurisdictions.*

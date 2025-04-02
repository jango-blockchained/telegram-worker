# Telegram Worker

A Cloudflare Worker service that handles Telegram notifications for the hoox trading system. This worker sends trading alerts and notifications through Telegram.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yourusername/hoox-trading/tree/main/telegram-worker)

## Features

- Trade notifications
- Error alerts
- Simple message formatting with HTML

## Prerequisites

- Node.js >= 16
- Bun (for package management)
- Wrangler CLI
- Cloudflare Workers account
- Telegram Bot Token (from @BotFather)

## Setup

1. Install dependencies:
```bash
bun install
```

2. Set your Cloudflare account ID in `wrangler.toml`:
```toml
name = "telegram-worker"
account_id = "your_account_id_here"
main = "src/index.js"
```

3. Configure environment variables in `.dev.vars` for local development:
```env
INTERNAL_SERVICE_KEY=your_internal_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ALLOWED_CHAT_IDS=123456789,987654321
```

4. Configure production secrets:
```bash
wrangler secret put INTERNAL_SERVICE_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put ALLOWED_CHAT_IDS
```

## Development

### Local Development

For local development, this worker should run on port 8790:

```bash
bun run dev -- --port 8790
```

The worker uses environment variables from `.dev.vars` during local development instead of the values in `wrangler.toml` or Cloudflare secrets.

### Production Deployment

Deploy to production:
```bash
bun run deploy
```

## API Usage

### Send Message

```http
POST /
Content-Type: application/json
X-Internal-Key: your_internal_key
X-Request-ID: unique_request_id

{
  "chatId": 123456789,
  "message": "Trade executed: BTCUSDT LONG @ 65000"
}
```

## Message Formatting

The worker supports HTML formatting:

```javascript
// HTML format
const message = `
<b>New Trade</b>
Exchange: <code>Binance</code>
Symbol: <code>BTCUSDT</code>
Action: <code>LONG</code>
Price: <code>65000</code>
`;
```

## Security

- Internal service authentication with X-Internal-Key
- Request ID validation with X-Request-ID
- Error message sanitization

## Error Handling

The worker includes error handling for:
- Telegram API errors
- Authentication failures
- Invalid message format
- Missing required parameters

## Response Format

Success:
```json
{
  "success": true,
  "requestId": "unique_request_id",
  "telegramResponse": {
    // Telegram API response
  }
}
```

Error:
```json
{
  "success": false,
  "error": "Error message"
}
```

## Future Enhancements

Planned features for future versions:
- Command processing
- User authentication
- Interactive buttons and menus
- Callback query handling
- Custom keyboard support

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request 
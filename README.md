# Telegram Worker

A Cloudflare Worker service that handles Telegram bot interactions for the grid trading system. This worker manages notifications, commands, and user interactions through Telegram.

## Features

- Trade notifications
- Error alerts
- Command processing
- User authentication
- Message formatting
- Interactive buttons and menus

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

2. Configure environment variables in `.dev.vars` for local development:
```env
INTERNAL_SERVICE_KEY=your_internal_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ALLOWED_CHAT_IDS=123456789,987654321
```

3. Configure production secrets:
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

When testing webhook functionality with Telegram, you may need to use a service like ngrok to expose your local server to the internet:

```bash
ngrok http 8790
```

### Production Deployment

Deploy to production:
```bash
bun run deploy
```

## API Usage

### Send Message

```http
POST /send
Content-Type: application/json
Authorization: Bearer your_internal_key

{
  "chat_id": 123456789,
  "text": "Trade executed: BTCUSDT LONG @ 65000",
  "parse_mode": "HTML"
}
```

### Send Trade Alert

```http
POST /trade-alert
Content-Type: application/json
Authorization: Bearer your_internal_key

{
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "action": "LONG",
  "price": 65000,
  "quantity": 0.001,
  "success": true,
  "orderId": "123456"
}
```

## Bot Commands

- `/start` - Initialize the bot
- `/status` - Get current trading status
- `/positions` - List open positions
- `/balance` - Show account balance
- `/help` - Display help message

## Message Formatting

The worker supports both HTML and Markdown formatting:

```javascript
// HTML format
const message = `
<b>New Trade</b>
Exchange: <code>Binance</code>
Symbol: <code>BTCUSDT</code>
Action: <code>LONG</code>
Price: <code>65000</code>
`;

// Markdown format
const message = `
*New Trade*
Exchange: \`Binance\`
Symbol: \`BTCUSDT\`
Action: \`LONG\`
Price: \`65000\`
`;
```

## Security

- Internal service authentication
- Allowed chat IDs validation
- Command access control
- Rate limiting per chat
- Error message sanitization

## Error Handling

The worker includes comprehensive error handling for:
- Telegram API errors
- Authentication failures
- Invalid message format
- Network issues
- Rate limiting

## Response Format

Success:
```json
{
  "success": true,
  "message_id": 123,
  "chat_id": 123456789
}
```

Error:
```json
{
  "success": false,
  "error": "Error message"
}
```

## Interactive Features

The worker supports Telegram's interactive features:
- Inline keyboards
- Custom keyboards
- Callback queries
- Message editing
- Interactive menus

Example inline keyboard:
```javascript
{
  "reply_markup": {
    "inline_keyboard": [
      [
        { "text": "View Position", "callback_data": "position_123" },
        { "text": "Close Position", "callback_data": "close_123" }
      ]
    ]
  }
}
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a new Pull Request 
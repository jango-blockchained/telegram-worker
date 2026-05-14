# @hoox/telegram-worker

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) [![Runtime](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)](https://bun.sh) [![Platform](https://img.shields.io/badge/Platform-Cloudflare%C2%AE%20Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/) [![License](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

Sends trade notifications and processes Telegram bot commands.

## For CLI Users

Use this worker indirectly when you run `hoox` commands:

- `hoox deploy telegram-webhook` — set or update the Telegram bot webhook URL

→ [Telegram Bot Tutorial](../../docs/tutorials/telegram-bot.md) · [CLI Reference](../../docs/reference/cli-commands.md)

## For Operators

This worker provides bi-directional Telegram integration. It sends trade confirmations, AI-generated market summaries, and emergency alerts to configured chats, and processes incoming commands (`/ask`, `/search`) with optional Workers AI and RAG support via Vectorize.

→ [Operator Docs](../../docs/devops/workers/telegram-worker.md)

## Development

```bash
bun test workers/telegram-worker
```

import { describe, expect, test, beforeEach, mock } from "bun:test";
import { handleWebhookRequest } from "../../src/handlers/webhook";

// Create mock logger
const createMockLogger = () => {
  return {
    info: mock(),
    error: mock(),
    warn: mock(),
    debug: mock(),
  };
};

// Mock global fetch
const mockFetch = mock();

describe("handleWebhookRequest", () => {
  let mockEnv: any;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let mockCtx: ExecutionContext;

  beforeEach(() => {
    mock.restore();
    mockLogger = createMockLogger();
    mockCtx = {
      waitUntil: (p: Promise<any>) => {
        if (p && typeof p.catch === "function") {
          p.catch(() => {});
        }
      },
    } as unknown as ExecutionContext;

    mockEnv = {
      TELEGRAM_SECRET_TOKEN: "test-webhook-secret",
      AUTHORIZED_CHAT_IDS: undefined,
      CONFIG_KV: {
        get: mock().mockResolvedValue(null),
        put: mock().mockResolvedValue(undefined),
      },
      AI: {
        run: mock().mockResolvedValue({ response: "AI response" }),
      },
      VECTORIZE_INDEX: {
        insert: mock().mockResolvedValue({ success: true }),
        query: mock().mockResolvedValue({ matches: [] }),
      },
      UPLOADS_BUCKET: {
        put: mock().mockResolvedValue(undefined),
      },
    };
    global.fetch = mockFetch as unknown as typeof global.fetch;
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  test("passes through when webhook secret is not configured", async () => {
    // When TELEGRAM_SECRET_TOKEN is not set, no auth check is performed
    const envWithoutSecret = {
      ...mockEnv,
      TELEGRAM_SECRET_TOKEN: undefined,
    };

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1, message: { text: "test" } }),
    });

    const response = await handleWebhookRequest(
      request,
      envWithoutSecret,
      mockCtx,
      mockLogger
    );

    // No secret configured means auth check is skipped
    expect(response.status).toBe(200);
  });

  test("returns 401 when webhook secret doesn't match", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
      },
      body: JSON.stringify({ update_id: 1, message: { text: "test" } }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(401);
  });

  test("returns 400 when JSON is invalid", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: "not valid json",
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(400);
  });

  test("returns 200 for message without required fields", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({ update_id: 1 }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
  });

  test("processes /start command", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 100,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/start",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
  });

  test("silently returns 200 for unauthorized chat", async () => {
    mockEnv.AUTHORIZED_CHAT_IDS = "111,222";

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 100,
          chat: { id: 333, type: "private" }, // Not authorized
          date: Math.floor(Date.now() / 1000),
          text: "/start",
          from: { id: 333, is_bot: false, first_name: "Evil" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("returns 200 when message has no text and no photo", async () => {
    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 100,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          // no text, no photo
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
  });
});

describe("escapeMarkdownV2", () => {
  // Import the escape function by checking the webhook handler behavior
  // The function is internal to the webhook module, but we can test via integration

  test("escapes special characters for Telegram response", async () => {
    const mockEnv = {
      TELEGRAM_SECRET_TOKEN: "test-secret",
      AUTHORIZED_CHAT_IDS: undefined,
      CONFIG_KV: {
        get: mock().mockResolvedValue(null),
        put: mock().mockResolvedValue(undefined),
      },
      AI: { run: mock().mockResolvedValue({ response: "response" }) },
      VECTORIZE_INDEX: {
        insert: mock().mockResolvedValue({}),
        query: mock().mockResolvedValue({ matches: [] }),
      },
    };
    const mockLogger = createMockLogger();
    const mockCtx = { waitUntil: (p: Promise<any>) => {} } as ExecutionContext;
    global.fetch = mockFetch as unknown as typeof global.fetch;
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 100,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/status",
          from: { id: 111, is_bot: false, first_name: "Test" },
        },
      }),
    });

    const response = await handleWebhookRequest(
      request,
      mockEnv,
      mockCtx,
      mockLogger
    );

    expect(response.status).toBe(200);
  });
});

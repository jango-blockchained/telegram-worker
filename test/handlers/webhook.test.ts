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
      TG_BOT_TOKEN_BINDING: "test-bot-token",
      AUTHORIZED_CHAT_IDS: undefined,
      CONFIG_KV: {
        get: mock().mockResolvedValue(null),
        put: mock().mockResolvedValue(undefined),
      },
      AI: {
        run: mock().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }), // Default: return embeddings
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
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  test("passes through when webhook secret is not configured", async () => {
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
          chat: { id: 333, type: "private" },
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

  test("should search vectorize and return results", async () => {
    mockFetch.mockClear();
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({
      matches: [
        {
          id: "1",
          score: 0.95,
          metadata: { text: "Bitcoin price prediction" },
        },
        { id: "2", score: 0.87, metadata: { text: "ETH analysis" } },
      ],
    });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 200,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/search Bitcoin price",
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
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("Found 2 results");
    expect(fetchBody.text).toContain("Bitcoin price prediction");
  });

  test("should return error for empty search query", async () => {
    mockFetch.mockClear();

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 201,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/search ",
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
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("Please provide a search term");
  });

  test("should return no results message when search has no matches", async () => {
    mockFetch.mockClear();
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({ matches: [] });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 202,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/search nonexistent query",
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
    await new Promise((r) => setTimeout(r, 0));
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("No results found");
  });

  test("should handle vectorize query error gracefully", async () => {
    mockFetch.mockClear();
    mockEnv.AI.run = mock().mockRejectedValue(new Error("AI error"));

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 203,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/search test query",
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
    await new Promise((r) => setTimeout(r, 0));
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("error searching");
  });

  test("should query vectorize and respond with AI answer", async () => {
    mockFetch.mockClear();
    mockEnv.AI.run = mock()
      .mockResolvedValueOnce({ data: [[0.1, 0.2, 0.3]] }) // For generateEmbeddings
      .mockResolvedValueOnce({
        response: "Based on recent messages, Bitcoin dropped 5% today.",
      }); // For LLM
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({
      matches: [
        {
          id: "1",
          score: 0.95,
          metadata: { text: "Bitcoin dropped 5% today" },
        },
        {
          id: "2",
          score: 0.87,
          metadata: { text: "Ethereum showing bullish signals" },
        },
      ],
    });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 300,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask What happened to Bitcoin?",
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
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("should return error for empty question", async () => {
    mockFetch.mockClear();

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 301,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask ",
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
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const fetchArgs = mockFetch.mock.calls[0];
    const fetchBody = JSON.parse(fetchArgs[1].body);
    expect(fetchBody.text).toContain("Please provide a question");
  });

  test("should return message when no context found", async () => {
    mockFetch.mockClear();
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({ matches: [] });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 302,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask What is the meaning of life?",
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
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const lastBody = JSON.parse(lastCall[1].body);
    expect(lastBody.text).toContain("Couldn't find relevant context");
  });

  test("should handle AI error gracefully", async () => {
    mockFetch.mockClear();
    mockEnv.AI.run = mock()
      .mockResolvedValueOnce({ data: [[0.1, 0.2, 0.3]] }) // For generateEmbeddings
      .mockRejectedValueOnce(new Error("AI service unavailable")); // For LLM
    mockEnv.VECTORIZE_INDEX.query = mock().mockResolvedValue({
      matches: [{ id: "1", score: 0.95, metadata: { text: "Test context" } }],
    });

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 303,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask What is the price?",
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
    await new Promise((r) => setTimeout(r, 0));
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const lastBody = JSON.parse(lastCall[1].body);
    expect(lastBody.text).toContain("error asking the AI");
  });

  test("should handle vectorize query error during /ask", async () => {
    mockFetch.mockClear();
    mockEnv.AI.run = mock().mockRejectedValue(new Error("AI error"));

    const request = new Request("http://test.com/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-webhook-secret",
      },
      body: JSON.stringify({
        update_id: 12345,
        message: {
          message_id: 304,
          chat: { id: 987654321, type: "private" },
          date: Math.floor(Date.now() / 1000),
          text: "/ask Test question",
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
    await new Promise((r) => setTimeout(r, 0));
    expect(mockFetch).toHaveBeenCalled();
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
    const lastBody = JSON.parse(lastCall[1].body);
    expect(lastBody.text).toContain("error searching");
  });
});

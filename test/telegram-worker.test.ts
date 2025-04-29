import { describe, expect, test, beforeEach, jest } from "@jest/globals";
import telegramWorker from "../src/index.js";

const PROCESS_ENDPOINT = "/process"; // Define the endpoint used in the worker

describe("Telegram Worker", () => {
  const TEST_INTERNAL_KEY = "test-internal-key";
  const TEST_BOT_TOKEN = "test-bot-token";
  const TEST_CHAT_ID = "default-chat-id";

  // Mock environment setup function
  const createMockEnv = (secrets: {
    internalKey?: string | null;
    botToken?: string | null;
    chatId?: string | null;
  }) => ({
    INTERNAL_KEY_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.internalKey),
    },
    TG_BOT_TOKEN_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.botToken),
    },
    TG_CHAT_ID_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.chatId),
    },
  });

  let mockEnv: ReturnType<typeof createMockEnv>;
  let fetchMock: jest.Mock;

  const validNotification = {
    message: "⚠️ BTC Hoox Signal: LONG at 50000",
    chatId: 123456789, // Explicit chat ID in request
  };

  const validNotificationDefaultChat = {
    message: "⚠️ ETH Hoox Signal: SHORT at 3000",
    // No chatId, should use default from binding
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Set up default valid environment
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
    });

    // Mock global fetch for Telegram API calls
    fetchMock = jest
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 123 } }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    global.fetch = fetchMock;
  });

  test("rejects request with invalid internal key", async () => {
    mockEnv = createMockEnv({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      internalKey: null,
    }); // No internal key configured
    const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "X-Internal-Key": "invalid-key" },
      body: JSON.stringify({ payload: validNotification, internalAuthKey: "invalid-key", requestId: "test-req-1" }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(500); // Config error
    expect(fetchMock).not.toHaveBeenCalled(); // Telegram should not be called
    expect(mockEnv.INTERNAL_KEY_BINDING.get).toHaveBeenCalledTimes(1);
  });

  test("rejects request if internalAuthKey doesn't match secret", async () => {
    // mockEnv has TEST_INTERNAL_KEY
    const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validNotification, internalAuthKey: "wrong-key", requestId: "test-req-2" }),
    });
    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(403); // Unauthorized
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockEnv.INTERNAL_KEY_BINDING.get).toHaveBeenCalledTimes(1);
  });

  test("sends telegram message with explicit chat ID", async () => {
    const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validNotification, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-1" }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    const responseData = await response.json();
    expect(responseData.success).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(fetchCallArgs[0]).toContain(TEST_BOT_TOKEN); // URL includes bot token
    const fetchBody = JSON.parse(fetchCallArgs[1].body);
    expect(fetchBody.chat_id).toBe(validNotification.chatId); // Uses explicit chat ID
    expect(fetchBody.text).toBe(validNotification.message);
    expect(mockEnv.INTERNAL_KEY_BINDING.get).toHaveBeenCalledTimes(1);
    expect(mockEnv.TG_BOT_TOKEN_BINDING.get).toHaveBeenCalledTimes(1);
    expect(mockEnv.TG_CHAT_ID_BINDING.get).toHaveBeenCalledTimes(1); // Default chat ID is retrieved even if not used
  });

  test("sends telegram message with default chat ID from binding", async () => {
    const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validNotificationDefaultChat, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-2" }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    const responseData = await response.json();
    expect(responseData.success).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchCallArgs = fetchMock.mock.calls[0];
    const fetchBody = JSON.parse(fetchCallArgs[1].body);
    expect(fetchBody.chat_id).toBe(TEST_CHAT_ID); // Uses default chat ID from env mock
    expect(fetchBody.text).toBe(validNotificationDefaultChat.message);
    expect(mockEnv.TG_CHAT_ID_BINDING.get).toHaveBeenCalledTimes(1);
  });

  test("returns error if default chat ID binding fails and no chat ID in request", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: null,
    }); // Default chat ID is null
    const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validNotificationDefaultChat, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-3" }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(500);
    const responseData = await response.json();
    expect(responseData.error).toContain("Chat ID configuration error");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns error if bot token binding fails", async () => {
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: null,
      chatId: TEST_CHAT_ID,
    }); // Bot token is null
    const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validNotification, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-4" }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(500);
    const responseData = await response.json();
    expect(responseData.error).toContain("Telegram bot token not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("handles Telegram API fetch errors", async () => {
    fetchMock.mockRejectedValue(new Error("Network Error")); // Simulate fetch failure

    const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validNotification, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-5" }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(500);
    const responseData = await response.json();
    expect(responseData.error).toContain("Network Error");
  });

  test("handles non-200 response from Telegram API", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, description: "Chat not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      )
    );

    const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: validNotification, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-6" }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(500);
    const responseData = await response.json();
    expect(responseData.error).toContain("Telegram API request failed");
    expect(responseData.error).toContain("(404)");
    expect(responseData.error).toContain("Chat not found");
  });
});

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
    webhookSecret?: string | null;
  }) => ({
    INTERNAL_KEY_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.internalKey),
    },
    TG_BOT_TOKEN_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.botToken),
    },
    TELEGRAM_SECRET_TOKEN: secrets.webhookSecret,
    TG_CHAT_ID_BINDING: {
      get: jest.fn().mockResolvedValue(secrets.chatId),
    },
    // Add mock for CONFIG_KV used by middleware
    CONFIG_KV: {
      get: jest.fn().mockResolvedValue(null), // Default mock
      put: jest.fn().mockResolvedValue(undefined),
    } as any,
    // Add mocks for AI, VECTORIZE_INDEX, UPLOADS_BUCKET if needed
    AI: {
      run: jest.fn(),
    },
    VECTORIZE_INDEX: {
      insert: jest.fn(),
      query: jest.fn(),
    },
    UPLOADS_BUCKET: {
      get: jest.fn(),
      put: jest.fn(),
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
    expect(response.status).toBe(401); // Unauthorized
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

// --- New Describe block for Helper Functions ---
describe("Telegram Worker Helpers", () => {
  let mockEnv: ReturnType<typeof createMockEnv>; // Use the enhanced mock env setup
  const TEST_BOT_TOKEN = "test-bot-token"; // Needed for some helpers potentially
  const TEST_CHAT_ID = "default-chat-id";

  // Reset mocks specific to these tests
  const mockAiRun = jest.fn();
  const mockVectorizeInsert = jest.fn();
  const mockVectorizeQuery = jest.fn();
  const mockR2Get = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv = createMockEnv({
      botToken: TEST_BOT_TOKEN, // Include necessary base secrets
      chatId: TEST_CHAT_ID,
    });
    // Assign specific mocks from the test suite
    mockEnv.AI.run = mockAiRun;
    mockEnv.VECTORIZE_INDEX.insert = mockVectorizeInsert;
    mockEnv.VECTORIZE_INDEX.query = mockVectorizeQuery;
    mockEnv.UPLOADS_BUCKET.get = mockR2Get;

    // Mock fetch for sendTelegramReply if needed (not directly tested here yet)
    global.fetch = jest.fn();
  });

  // Dynamically import the functions to test after mocks are set up
  let generateEmbeddings: (text: string | string[], env: any) => Promise<number[][]>;
  let insertEmbeddings: (vectors: number[][], metadata: any[], env: any) => Promise<void>;
  let queryEmbeddings: (queryText: string, env: any, topK?: number) => Promise<any>;
  let handleGetLatestTradeSignalR2: (env: any) => Promise<any | null>;

  beforeAll(async () => {
    // Import the specific functions needed
    const module = await import("../src/index.js");
    generateEmbeddings = module.generateEmbeddings;
    insertEmbeddings = module.insertEmbeddings;
    queryEmbeddings = module.queryEmbeddings;
    handleGetLatestTradeSignalR2 = module.handleGetLatestTradeSignalR2;
  });

  // --- generateEmbeddings Tests ---
  describe("generateEmbeddings", () => {
    test("should call AI binding and return embeddings", async () => {
      const inputText = "Test message";
      const mockEmbedding = [[0.1, 0.2, 0.3]];
      mockAiRun.mockResolvedValue({ data: mockEmbedding });

      const result = await generateEmbeddings(inputText, mockEnv);

      expect(result).toEqual(mockEmbedding);
      expect(mockAiRun).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: inputText });
    });

    test("should throw error if AI binding is missing", async () => {
      delete (mockEnv as any).AI; // Remove AI binding
      await expect(generateEmbeddings("Test", mockEnv)).rejects.toThrow("AI service not available.");
    });

    test("should throw error if AI run fails", async () => {
      const error = new Error("AI API Error");
      mockAiRun.mockRejectedValue(error);
      await expect(generateEmbeddings("Test", mockEnv)).rejects.toThrow(`Failed to generate embeddings: ${error.message}`);
    });

     test("should throw error if AI response format is invalid", async () => {
      mockAiRun.mockResolvedValue({ invalid: "structure" }); // No 'data' field
      await expect(generateEmbeddings("Test", mockEnv)).rejects.toThrow("Failed to parse embeddings from AI response.");
    });
  });

  // --- insertEmbeddings Tests ---
  describe("insertEmbeddings", () => {
    const vectors = [[0.1], [0.2]];
    const metadata = [{ messageId: "m1", text: "t1" }, { messageId: "m2", text: "t2" }];

    test("should call Vectorize index insert with correct data", async () => {
      mockVectorizeInsert.mockResolvedValue({ success: true, count: 2 });
      await insertEmbeddings(vectors, metadata, mockEnv);

      expect(mockVectorizeInsert).toHaveBeenCalledTimes(1);
      expect(mockVectorizeInsert).toHaveBeenCalledWith([
        { id: "m1", values: [0.1], metadata: metadata[0] },
        { id: "m2", values: [0.2], metadata: metadata[1] },
      ]);
    });

    test("should throw error if Vectorize binding is missing", async () => {
      delete (mockEnv as any).VECTORIZE_INDEX;
      await expect(insertEmbeddings(vectors, metadata, mockEnv)).rejects.toThrow("Vectorize service not available.");
    });

    test("should throw error if vector and metadata counts mismatch", async () => {
      await expect(insertEmbeddings(vectors, [metadata[0]], mockEnv)).rejects.toThrow("Number of vectors must match number of metadata objects.");
    });

    test("should handle Vectorize insert error", async () => {
      const error = new Error("Vectorize Insert Failed");
      mockVectorizeInsert.mockRejectedValue(error);
      await expect(insertEmbeddings(vectors, metadata, mockEnv)).rejects.toThrow(`Failed to insert embeddings: ${error.message}`);
    });

     test("should do nothing if vectors array is empty", async () => {
       await insertEmbeddings([], [], mockEnv);
       expect(mockVectorizeInsert).not.toHaveBeenCalled();
     });
  });

  // --- queryEmbeddings Tests ---
  describe("queryEmbeddings", () => {
    const queryText = "Search query";
    const queryEmbedding = [[0.5, 0.6]];
    const mockMatches = { matches: [{ id: "m1", score: 0.9, metadata: {} }] };

    beforeEach(() => {
        // Mock AI run for query embedding generation
        mockAiRun.mockResolvedValue({ data: queryEmbedding });
        // Mock Vectorize query
        mockVectorizeQuery.mockResolvedValue(mockMatches);
    });

    test("should generate query embedding and call Vectorize query", async () => {
      const result = await queryEmbeddings(queryText, mockEnv, 5);

      expect(result).toEqual(mockMatches);
      expect(mockAiRun).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: queryText });
      expect(mockVectorizeQuery).toHaveBeenCalledWith(queryEmbedding[0], { topK: 5, returnMetadata: true });
    });

    test("should use default topK if not provided", async () => {
      await queryEmbeddings(queryText, mockEnv);
      expect(mockVectorizeQuery).toHaveBeenCalledWith(queryEmbedding[0], { topK: 3, returnMetadata: true }); // Default is 3
    });

    test("should throw if AI binding is missing", async () => {
        delete (mockEnv as any).AI;
        await expect(queryEmbeddings(queryText, mockEnv)).rejects.toThrow("AI service not available for query embedding.");
    });

    test("should throw if Vectorize binding is missing", async () => {
        delete (mockEnv as any).VECTORIZE_INDEX;
        await expect(queryEmbeddings(queryText, mockEnv)).rejects.toThrow("Vectorize service not available.");
    });

     test("should throw if query embedding generation fails", async () => {
        const aiError = new Error("AI Fail");
        mockAiRun.mockRejectedValue(aiError);
        await expect(queryEmbeddings(queryText, mockEnv)).rejects.toThrow(`Failed to query embeddings: Failed to generate embeddings: ${aiError.message}`);
        expect(mockVectorizeQuery).not.toHaveBeenCalled();
     });

     test("should throw if Vectorize query fails", async () => {
        const vectorizeError = new Error("Vectorize Fail");
        mockVectorizeQuery.mockRejectedValue(vectorizeError);
        await expect(queryEmbeddings(queryText, mockEnv)).rejects.toThrow(`Failed to query embeddings: ${vectorizeError.message}`);
     });
  });

  // --- handleGetLatestTradeSignalR2 Tests ---
  describe("handleGetLatestTradeSignalR2", () => {
    test("should get object from R2 bucket", async () => {
      const mockR2Object = { body: "latest signal data", writeHttpMetadata: jest.fn(), };
      mockR2Get.mockResolvedValue(mockR2Object);

      const result = await handleGetLatestTradeSignalR2(mockEnv);

      expect(result).toBe(mockR2Object);
      expect(mockR2Get).toHaveBeenCalledWith("latest_trade_signal.json");
    });

    test("should return null if R2 binding is missing", async () => {
      delete (mockEnv as any).UPLOADS_BUCKET;
      const result = await handleGetLatestTradeSignalR2(mockEnv);
      expect(result).toBeNull();
      expect(mockR2Get).not.toHaveBeenCalled();
    });

    test("should return null if object not found in R2", async () => {
      mockR2Get.mockResolvedValue(null);
      const result = await handleGetLatestTradeSignalR2(mockEnv);
      expect(result).toBeNull();
      expect(mockR2Get).toHaveBeenCalledWith("latest_trade_signal.json");
    });

    test("should throw error if R2 get fails", async () => {
      const error = new Error("R2 Get Failed");
      mockR2Get.mockRejectedValue(error);
      await expect(handleGetLatestTradeSignalR2(mockEnv)).rejects.toThrow(`Failed to get latest signal from R2: ${error.message}`);
    });
  });
});

// --- Describe block for Webhook Handler ---
describe("Telegram Worker Webhook Handler (/webhook)", () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  const TEST_BOT_TOKEN = "test-bot-token";
  const TEST_CHAT_ID = "default-chat-id";
  const WEBHOOK_SECRET = "test-webhook-secret";
  const WEBHOOK_ENDPOINT = "/webhook";

  // Mocks specific to webhook tests
  const mockAiRun = jest.fn();
  const mockVectorizeInsert = jest.fn();
  const mockVectorizeQuery = jest.fn();
  const mockR2Get = jest.fn();
  const mockFetch = jest.fn(); // Mock global fetch for sendTelegramReply

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnv = createMockEnv({
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: WEBHOOK_SECRET,
    });
    // Assign specific mocks
    mockEnv.AI.run = mockAiRun;
    mockEnv.VECTORIZE_INDEX.insert = mockVectorizeInsert;
    mockEnv.VECTORIZE_INDEX.query = mockVectorizeQuery;
    mockEnv.UPLOADS_BUCKET.get = mockR2Get;
    global.fetch = mockFetch;

    // Default successful mocks
    mockAiRun.mockResolvedValue({ data: [[0.1]] }); // Mock embedding generation
    mockVectorizeInsert.mockResolvedValue({ success: true, count: 1 }); // Mock vectorize insert
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }), { status: 200 })); // Mock successful Telegram reply
    mockR2Get.mockResolvedValue(null); // Default: no R2 object found

  });

  afterEach(() => {
    // Restore Date.now mock if it was mocked
    jest.restoreAllMocks();
  });

  // --- Webhook Secret Validation Tests ---
  test("should reject request if webhook secret is missing in header", async () => {
    const request = new Request(`https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // Missing X-Telegram-Bot-Api-Secret-Token
      body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toBe("Unauthorized");
  });

  test("should reject request if webhook secret in header is incorrect", async () => {
    const request = new Request(`https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
      },
      body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toBe("Unauthorized");
  });

    test("should reject request if webhook secret is not configured in env", async () => {
    mockEnv = createMockEnv({ // Create env without the secret
        botToken: TEST_BOT_TOKEN,
        chatId: TEST_CHAT_ID,
    });
    const request = new Request(`https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET, // Header is present
      },
      body: JSON.stringify({ update_id: 1, message: { text: "hi" } }),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(401); // Still unauthorized as env var is missing
    const body = await response.text();
    expect(body).toBe("Unauthorized");
  });

  // --- Basic Message Handling Test ---
  test("should process valid text message, generate/insert embeddings, and reply", async () => {
    const messageText = "This is a test message";
    const chatId = 987654321;
    const messageId = 555;
    const date = Math.floor(Date.now() / 1000);
    const webhookBody = {
      update_id: 12345,
      message: {
        message_id: messageId,
        chat: { id: chatId, type: "private" },
        date: date,
        text: messageText,
        from: { id: 111, is_bot: false, first_name: "Test" },
      },
    };

    const request = new Request(`https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
      },
      body: JSON.stringify(webhookBody),
    });

    const response = await telegramWorker.fetch(request, mockEnv);
    expect(response.status).toBe(200); // Should return OK immediately

    // Use timers to allow async operations (embedding, reply) to be called
    await new Promise(resolve => setTimeout(resolve, 0));

    // 1. Check embedding generation
    expect(mockAiRun).toHaveBeenCalledTimes(1);
    expect(mockAiRun).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: [messageText] }); // Expect array

    // 2. Check Vectorize insertion
    expect(mockVectorizeInsert).toHaveBeenCalledTimes(1);
    const insertArgs = mockVectorizeInsert.mock.calls[0][0];
    expect(insertArgs).toHaveLength(1);
    expect(insertArgs[0].id).toBe(String(messageId));
    expect(insertArgs[0].values).toEqual([0.1]); // From mockAiRun
    expect(insertArgs[0].metadata).toEqual(expect.objectContaining({
        messageId: String(messageId),
        chatId: String(chatId),
        text: messageText,
        timestamp: expect.any(String), // Check it's a string (ISO format)
    }));

    // 3. Check Telegram reply (sendTelegramReply uses global fetch)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchCallArgs = mockFetch.mock.calls[0];
    expect(fetchCallArgs[0]).toContain(`https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`);
    const fetchBody = JSON.parse(fetchCallArgs[1].body);
    expect(fetchBody.chat_id).toBe(chatId);
    expect(fetchBody.text).toContain("Received your message"); // Basic reply check
  });

  // TODO: Add more webhook tests:
  // - Handling /latest_trade command (mock R2 get with data)
  // - Handling messages triggering Vectorize search (mock queryEmbeddings)
  // - Handling non-text messages or updates (e.g., photos, callbacks)
  // - Error handling if AI/Vectorize/R2/Telegram Reply fails within the webhook

});

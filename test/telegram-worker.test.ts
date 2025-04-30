import { describe, expect, test, beforeEach, mock, afterEach, beforeAll, Mock } from "bun:test";
import telegramWorker, { 
    generateEmbeddings, 
    insertEmbeddings, 
    queryEmbeddings, 
    handleGetLatestTradeSignalR2, 
} from "../src/index.js";
import type { KVNamespace, R2Bucket, VectorizeIndex, Fetcher } from '@cloudflare/workers-types';

// --- Mock Types --- 
interface MockBinding<T> {
  get: Mock<() => Promise<T | null>>;
}
interface MockKV { // Using any for simplicity
  get: Mock<() => Promise<any>>;
  put: Mock<() => Promise<any>>;
  list?: Mock<() => Promise<any>>;
  delete?: Mock<() => Promise<any>>;
}
interface MockAI { // Using any as @cloudflare/ai types might not be installed
  run: Mock<(...args: any[]) => Promise<any>>;
}
interface MockVectorize { // Simplified
  insert: Mock<(...args: any[]) => Promise<any>>;
  query: Mock<(...args: any[]) => Promise<any>>;
}
interface MockR2 { // Simplified
  get: Mock<(...args: any[]) => Promise<any>>;
  put: Mock<(...args: any[]) => Promise<any>>;
  head?: Mock<(...args: any[]) => Promise<any>>;
  delete?: Mock<(...args: any[]) => Promise<any>>;
  list?: Mock<(...args: any[]) => Promise<any>>;
}

// Define the actual Env structure used by the worker
// Use real types here
interface WorkerEnv { 
    INTERNAL_KEY_BINDING?: Fetcher; // Assuming it's a binding for a secret store
    TG_BOT_TOKEN_BINDING: Fetcher; // Assuming binding for secret
    TELEGRAM_SECRET_TOKEN?: string;
    TG_CHAT_ID_BINDING?: Fetcher; // Assuming binding for secret
    CONFIG_KV: KVNamespace;
    AI: any; // Use any because @cloudflare/ai might not be installed
    VECTORIZE_INDEX: VectorizeIndex;
    UPLOADS_BUCKET: R2Bucket;
    // Add other bindings if used
}

// Define a type for the mocked environment object we create in tests
type MockEnvForTest = {
  INTERNAL_KEY_BINDING?: MockBinding<string>;
  TG_BOT_TOKEN_BINDING: MockBinding<string>;
  TELEGRAM_SECRET_TOKEN?: string;
  TG_CHAT_ID_BINDING?: MockBinding<string>;
  CONFIG_KV: MockKV;
  AI: MockAI;
  VECTORIZE_INDEX: MockVectorize;
  UPLOADS_BUCKET: MockR2;
};

// Mock environment setup function
const createMockEnv = (secrets: {
  internalKey?: string | null;
  botToken?: string | null;
  chatId?: string | null;
  webhookSecret?: string | null;
}): MockEnvForTest => {
  const createR2Mock = (): MockR2 => ({
      get: mock(),
      put: mock(),
      head: mock(),
      delete: mock(),
      list: mock(),
  });
  
  return {
    INTERNAL_KEY_BINDING: secrets.internalKey !== undefined 
      ? { get: mock<() => Promise<string | null>>().mockResolvedValue(secrets.internalKey) } 
      : undefined,
    TG_BOT_TOKEN_BINDING: {
      get: mock<() => Promise<string | null>>().mockResolvedValue(secrets.botToken === undefined ? null : secrets.botToken),
    },
    TELEGRAM_SECRET_TOKEN: secrets.webhookSecret === null ? undefined : secrets.webhookSecret,
    TG_CHAT_ID_BINDING: secrets.chatId !== undefined
      ? { get: mock<() => Promise<string | null>>().mockResolvedValue(secrets.chatId) }
      : undefined,
    CONFIG_KV: {
      get: mock().mockResolvedValue(null), 
      put: mock().mockResolvedValue(undefined),
      list: mock().mockResolvedValue({ keys: [] }), // Add basic list mock
      delete: mock().mockResolvedValue(undefined), // Add basic delete mock
    } as MockKV, 
    AI: {
      run: mock(),
    },
    VECTORIZE_INDEX: {
      insert: mock(),
      query: mock(),
    } as unknown as VectorizeIndex, // Cast via unknown
    UPLOADS_BUCKET: createR2Mock() as unknown as R2Bucket, // Cast via unknown
  } as MockEnvForTest;
};

const PROCESS_ENDPOINT = "/process";

describe("Telegram Worker", () => {
  const TEST_INTERNAL_KEY = "test-internal-key";
  const TEST_BOT_TOKEN = "test-bot-token";
  const TEST_CHAT_ID = "default-chat-id";
  let mockEnv: MockEnvForTest;
  let fetchMock: ReturnType<typeof mock>; 
  const validNotification = { message: "...", chatId: 123 };
  const validNotificationDefaultChat = { message: "..." };

  beforeEach(() => {
    mock.restore(); 
    mockEnv = createMockEnv({
      internalKey: TEST_INTERNAL_KEY,
      botToken: TEST_BOT_TOKEN,
      chatId: TEST_CHAT_ID,
      webhookSecret: undefined, 
    });
    fetchMock = mock(global.fetch)
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), { status: 200, headers: { "Content-Type": "application/json" } })
      );
    global.fetch = fetchMock as unknown as typeof global.fetch; 
  });

  test("rejects request with invalid internal key", async () => {
     mockEnv = createMockEnv({ botToken: TEST_BOT_TOKEN, chatId: TEST_CHAT_ID, internalKey: null, webhookSecret: undefined, }); 
     const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, { method: "POST", headers: { "X-Internal-Key": "invalid-key" }, body: JSON.stringify({ payload: validNotification, internalAuthKey: "invalid-key", requestId: "test-req-1" }), });
     const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
     expect(response.status).toBe(500);
     const responseData = await response.json() as { error: string };
     expect(responseData.error).toContain("INTERNAL_KEY_BINDING secret not configured"); 
     expect(fetchMock).not.toHaveBeenCalled(); 
     expect(mockEnv.INTERNAL_KEY_BINDING).toBeUndefined(); 
   });

  test("rejects request if internalAuthKey doesn't match secret", async () => {
     mockEnv = createMockEnv({ internalKey: TEST_INTERNAL_KEY, botToken: TEST_BOT_TOKEN, chatId: TEST_CHAT_ID, webhookSecret: undefined, });
     const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: validNotification, internalAuthKey: "wrong-key", requestId: "test-req-2" }), });
     const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
     expect(response.status).toBe(401); 
     const responseData = await response.json() as { error: string };
     expect(responseData.error).toContain("Authentication failed");
     expect(fetchMock).not.toHaveBeenCalled();
     expect(mockEnv.INTERNAL_KEY_BINDING?.get).toHaveBeenCalledTimes(1);
   });
   
   test("sends telegram message with explicit chat ID", async () => {
     mockEnv = createMockEnv({ internalKey: TEST_INTERNAL_KEY, botToken: TEST_BOT_TOKEN, chatId: TEST_CHAT_ID, webhookSecret: undefined, });
     const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: validNotification, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-1" }), });
     const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
     expect(response.status).toBe(200);
     const responseData = await response.json() as { success: boolean };
     expect(responseData.success).toBe(true);
     expect(fetchMock).toHaveBeenCalledTimes(1);
     const fetchCallArgs = fetchMock.mock.calls[0];
     expect(fetchCallArgs[0]).toContain(TEST_BOT_TOKEN); 
     const fetchBody = JSON.parse(fetchCallArgs[1].body);
     expect(fetchBody.chat_id).toBe(validNotification.chatId); 
     expect(fetchBody.text).toBe(validNotification.message);
     expect(mockEnv.INTERNAL_KEY_BINDING?.get).toHaveBeenCalledTimes(1);
     expect(mockEnv.TG_BOT_TOKEN_BINDING.get).toHaveBeenCalledTimes(1);
     expect(mockEnv.TG_CHAT_ID_BINDING?.get).toHaveBeenCalledTimes(1); 
   });
   
   test("sends telegram message with default chat ID from binding", async () => {
     mockEnv = createMockEnv({ internalKey: TEST_INTERNAL_KEY, botToken: TEST_BOT_TOKEN, chatId: TEST_CHAT_ID, webhookSecret: undefined, });
     const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: validNotificationDefaultChat, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-2" }), });
     const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
     expect(response.status).toBe(200);
     const responseData = await response.json() as { success: boolean };
     expect(responseData.success).toBe(true);
     expect(fetchMock).toHaveBeenCalledTimes(1);
     const fetchCallArgs = fetchMock.mock.calls[0];
     const fetchBody = JSON.parse(fetchCallArgs[1].body);
     expect(fetchBody.chat_id).toBe(TEST_CHAT_ID); 
     expect(fetchBody.text).toBe(validNotificationDefaultChat.message);
     expect(mockEnv.TG_CHAT_ID_BINDING?.get).toHaveBeenCalledTimes(1);
   });
   
   test("returns error if default chat ID binding fails and no chat ID in request", async () => {
     mockEnv = createMockEnv({ internalKey: TEST_INTERNAL_KEY, botToken: TEST_BOT_TOKEN, chatId: null, webhookSecret: undefined, }); 
     const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: validNotificationDefaultChat, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-3" }), });
     const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
     expect(response.status).toBe(500);
     const responseData = await response.json() as { error: string };
     expect(responseData.error).toContain("Chat ID configuration error");
     expect(fetchMock).not.toHaveBeenCalled();
   });
   
   test("returns error if bot token binding fails", async () => {
     mockEnv = createMockEnv({ internalKey: TEST_INTERNAL_KEY, botToken: null, chatId: TEST_CHAT_ID, webhookSecret: undefined, }); 
     const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: validNotification, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-4" }), });
     const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
     expect(response.status).toBe(500);
     const responseData = await response.json() as { error: string };
     expect(responseData.error).toContain("Telegram bot token not configured");
     expect(fetchMock).not.toHaveBeenCalled();
   });
   
   test("handles Telegram API fetch errors", async () => {
     mockEnv = createMockEnv({ internalKey: TEST_INTERNAL_KEY, botToken: TEST_BOT_TOKEN, chatId: TEST_CHAT_ID, webhookSecret: undefined, });
     fetchMock.mockRejectedValue(new Error("Network Error")); 
     const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: validNotification, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-5" }), });
     const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
     expect(response.status).toBe(500);
     const responseData = await response.json() as { error: string };
     expect(responseData.error).toContain("Network Error");
   });
   
   test("handles non-200 response from Telegram API", async () => {
     mockEnv = createMockEnv({ internalKey: TEST_INTERNAL_KEY, botToken: TEST_BOT_TOKEN, chatId: TEST_CHAT_ID, webhookSecret: undefined, });
     fetchMock.mockResolvedValue( new Response( JSON.stringify({ ok: false, description: "Chat not found" }), { status: 404, headers: { "Content-Type": "application/json" } } ) );
     const request = new Request(`https://telegram-worker.workers.dev${PROCESS_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: validNotification, internalAuthKey: TEST_INTERNAL_KEY, requestId: "req-6" }), });
     const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
     expect(response.status).toBe(500);
     const responseData = await response.json() as { error: string };
     expect(responseData.error).toContain("Telegram API request failed");
     expect(responseData.error).toContain("(404)");
     expect(responseData.error).toContain("Chat not found");
   });
});

describe("Telegram Worker Helpers", () => {
  let mockEnv: MockEnvForTest;
  const TEST_BOT_TOKEN = "test-bot-token";
  const TEST_CHAT_ID = "default-chat-id";
  const mockAiRun = mock();
  const mockVectorizeInsert = mock();
  const mockVectorizeQuery = mock();
  const mockR2Get = mock();

  beforeEach(() => {
     mock.restore();
     mockEnv = createMockEnv({ botToken: TEST_BOT_TOKEN, chatId: TEST_CHAT_ID, internalKey: undefined, webhookSecret: undefined, });
     mockEnv.AI.run = mockAiRun;
     mockEnv.VECTORIZE_INDEX.insert = mockVectorizeInsert;
     mockEnv.VECTORIZE_INDEX.query = mockVectorizeQuery;
     mockEnv.UPLOADS_BUCKET.get = mockR2Get;
     global.fetch = mock() as unknown as typeof global.fetch; 
   });

  let generateEmbeddingsFn: (text: string | string[], env: WorkerEnv) => Promise<number[][]>;
  let insertEmbeddingsFn: (vectors: number[][], metadata: any[], env: WorkerEnv) => Promise<void>; 
  let queryEmbeddingsFn: (queryText: string, env: WorkerEnv, topK?: number) => Promise<any>; 
  let handleGetLatestTradeSignalR2Fn: (env: WorkerEnv) => Promise<any | null>;

  beforeAll(async () => {
    const module = await import("../src/index.js");
    generateEmbeddingsFn = module.generateEmbeddings;
    insertEmbeddingsFn = module.insertEmbeddings;
    queryEmbeddingsFn = module.queryEmbeddings;
    handleGetLatestTradeSignalR2Fn = module.handleGetLatestTradeSignalR2;
  });

  describe("generateEmbeddings", () => {
    test("should call AI binding and return embeddings", async () => {
       const inputText = "Test message";
       const mockEmbedding = [[0.1, 0.2, 0.3]];
       mockAiRun.mockResolvedValue({ data: mockEmbedding });
       const result = await generateEmbeddingsFn(inputText, mockEnv as unknown as WorkerEnv);
       expect(result).toEqual(mockEmbedding);
       expect(mockAiRun).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: inputText });
    });
     test("should throw error if AI binding is missing", async () => {
      const envWithoutAI = { ...mockEnv, AI: undefined } as unknown as WorkerEnv;
      await expect(generateEmbeddingsFn("Test", envWithoutAI)).rejects.toThrow("AI service not available.");
    });
     test("should throw error if AI run fails", async () => {
       const error = new Error("AI API Error");
       mockAiRun.mockRejectedValue(error);
       await expect(generateEmbeddingsFn("Test", mockEnv as unknown as WorkerEnv)).rejects.toThrow(`Failed to generate embeddings: ${error.message}`);
     });
     test("should throw error if AI response format is invalid", async () => {
       mockAiRun.mockResolvedValue({ invalid: "structure" }); 
       await expect(generateEmbeddingsFn("Test", mockEnv as unknown as WorkerEnv)).rejects.toThrow("Failed to parse embeddings from AI response.");
     });
  });

  describe("insertEmbeddings", () => {
      const vectors = [[0.1], [0.2]];
      const metadata = [{ messageId: "m1", text: "t1" }, { messageId: "m2", text: "t2" }];
      test("should call Vectorize index insert with correct data", async () => {
         mockVectorizeInsert.mockResolvedValue({ success: true, count: 2 });
         await insertEmbeddingsFn(vectors, metadata, mockEnv as unknown as WorkerEnv);
         expect(mockVectorizeInsert).toHaveBeenCalledTimes(1);
         expect(mockVectorizeInsert).toHaveBeenCalledWith([{ id: "m1", values: [0.1], metadata: metadata[0] }, { id: "m2", values: [0.2], metadata: metadata[1] }, ]);
      });
       test("should throw error if Vectorize binding is missing", async () => {
         const envWithoutVec = { ...mockEnv, VECTORIZE_INDEX: undefined } as unknown as WorkerEnv;
         await expect(insertEmbeddingsFn(vectors, metadata, envWithoutVec)).rejects.toThrow("Vectorize service not available.");
       });
      test("should throw error if vector and metadata counts mismatch", async () => {
         await expect(insertEmbeddingsFn(vectors, [metadata[0]], mockEnv as unknown as WorkerEnv)).rejects.toThrow("Number of vectors must match number of metadata objects.");
       });
      test("should handle Vectorize insert error", async () => {
         const error = new Error("Vectorize Insert Failed");
         mockVectorizeInsert.mockRejectedValue(error);
         await expect(insertEmbeddingsFn(vectors, metadata, mockEnv as unknown as WorkerEnv)).rejects.toThrow(`Failed to insert embeddings: ${error.message}`);
       });
       test("should do nothing if vectors array is empty", async () => {
         await insertEmbeddingsFn([], [], mockEnv as unknown as WorkerEnv);
         expect(mockVectorizeInsert).not.toHaveBeenCalled();
       });
  });

   describe("queryEmbeddings", () => {
       const queryText = "Search query";
       const queryEmbedding = [[0.5, 0.6]];
       const mockMatches = { matches: [{ id: "m1", score: 0.9, metadata: {} }] };
       beforeEach(() => {
         mockAiRun.mockResolvedValue({ data: queryEmbedding });
         mockVectorizeQuery.mockResolvedValue(mockMatches);
       });
       test("should generate query embedding and call Vectorize query", async () => {
         const result = await queryEmbeddingsFn(queryText, mockEnv as unknown as WorkerEnv, 5);
         expect(result).toEqual(mockMatches);
         expect(mockAiRun).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: queryText });
         expect(mockVectorizeQuery).toHaveBeenCalledWith(queryEmbedding[0], { topK: 5, returnMetadata: true });
       });
       test("should use default topK if not provided", async () => {
         await queryEmbeddingsFn(queryText, mockEnv as unknown as WorkerEnv);
         expect(mockVectorizeQuery).toHaveBeenCalledWith(queryEmbedding[0], { topK: 3, returnMetadata: true }); 
       });
       test("should throw if AI binding is missing", async () => {
         const envWithoutAI = { ...mockEnv, AI: undefined } as unknown as WorkerEnv;
         await expect(queryEmbeddingsFn(queryText, envWithoutAI)).rejects.toThrow("AI service not available for query embedding.");
       });
       test("should throw if Vectorize binding is missing", async () => {
         const envWithoutVec = { ...mockEnv, VECTORIZE_INDEX: undefined } as unknown as WorkerEnv;
         await expect(queryEmbeddingsFn(queryText, envWithoutVec)).rejects.toThrow("Vectorize service not available.");
       });
       test("should throw if query embedding generation fails", async () => {
         const aiError = new Error("AI Fail");
         mockAiRun.mockRejectedValue(aiError);
         await expect(queryEmbeddingsFn(queryText, mockEnv as unknown as WorkerEnv)).rejects.toThrow(`Failed to query embeddings: Failed to generate embeddings: ${aiError.message}`);
         expect(mockVectorizeQuery).not.toHaveBeenCalled();
       });
       test("should throw if Vectorize query fails", async () => {
         const vectorizeError = new Error("Vectorize Fail");
         mockVectorizeQuery.mockRejectedValue(vectorizeError);
         await expect(queryEmbeddingsFn(queryText, mockEnv as unknown as WorkerEnv)).rejects.toThrow(`Failed to query embeddings: ${vectorizeError.message}`);
       });
   });
   
   describe("handleGetLatestTradeSignalR2", () => {
       test("should get object from R2 bucket", async () => {
         const mockR2Object = { body: "latest signal data", writeHttpMetadata: mock() }; 
         mockR2Get.mockResolvedValue(mockR2Object);
         const result = await handleGetLatestTradeSignalR2Fn(mockEnv as unknown as WorkerEnv);
         expect(result).toBe(mockR2Object);
         expect(mockR2Get).toHaveBeenCalledWith("latest_trade_signal.json");
       });
        test("should return null if R2 binding is missing", async () => {
          const envWithoutR2 = { ...mockEnv, UPLOADS_BUCKET: undefined } as unknown as WorkerEnv;
          const result = await handleGetLatestTradeSignalR2Fn(envWithoutR2);
           expect(result).toBeNull();
           expect(mockR2Get).not.toHaveBeenCalled();
       });
       test("should return null if object not found in R2", async () => {
         mockR2Get.mockResolvedValue(null);
         const result = await handleGetLatestTradeSignalR2Fn(mockEnv as unknown as WorkerEnv);
         expect(result).toBeNull();
         expect(mockR2Get).toHaveBeenCalledWith("latest_trade_signal.json");
       });
       test("should throw error if R2 get fails", async () => {
         const error = new Error("R2 Get Failed");
         mockR2Get.mockRejectedValue(error);
         await expect(handleGetLatestTradeSignalR2Fn(mockEnv as unknown as WorkerEnv)).rejects.toThrow(`Failed to get latest signal from R2: ${error.message}`);
       });
   });
});

describe("Telegram Worker Webhook Handler (/webhook)", () => {
  let mockEnv: MockEnvForTest;
  const TEST_BOT_TOKEN = "test-bot-token";
  const TEST_CHAT_ID = "default-chat-id";
  const WEBHOOK_SECRET = "test-webhook-secret";
  const WEBHOOK_ENDPOINT = "/webhook";
  const mockAiRun = mock();
  const mockVectorizeInsert = mock();
  const mockVectorizeQuery = mock();
  const mockR2Get = mock();
  const mockFetch = mock();

   beforeEach(() => {
     mock.restore();
     mockEnv = createMockEnv({ botToken: TEST_BOT_TOKEN, chatId: TEST_CHAT_ID, webhookSecret: WEBHOOK_SECRET, internalKey: undefined, });
     mockEnv.AI.run = mockAiRun;
     mockEnv.VECTORIZE_INDEX.insert = mockVectorizeInsert;
     mockEnv.VECTORIZE_INDEX.query = mockVectorizeQuery;
     mockEnv.UPLOADS_BUCKET.get = mockR2Get;
     global.fetch = mockFetch as unknown as typeof global.fetch; 
     mockAiRun.mockResolvedValue({ data: [[0.1]] });
     mockVectorizeInsert.mockResolvedValue({ success: true, count: 1 }); 
     mockFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }), { status: 200 })); 
     mockR2Get.mockResolvedValue(null); 
   });

  afterEach(() => {
    mock.restore();
  });

  test("should reject request if webhook secret is missing in header", async () => {
    const request = new Request(`https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ update_id: 1, message: { text: "hi" } }), });
    const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toBe("Unauthorized");
  });

  test("should reject request if webhook secret in header is incorrect", async () => {
    const request = new Request(`https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "wrong-secret", }, body: JSON.stringify({ update_id: 1, message: { text: "hi" } }), });
    const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
     expect(response.status).toBe(401);
     const body = await response.text();
     expect(body).toBe("Unauthorized");
  });

  test("should reject request if webhook secret is not configured in env", async () => {
    mockEnv = createMockEnv({ botToken: TEST_BOT_TOKEN, chatId: TEST_CHAT_ID, internalKey: undefined, webhookSecret: undefined, });
    const request = new Request(`https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET, }, body: JSON.stringify({ update_id: 1, message: { text: "hi" } }), });
    const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toBe("Unauthorized");
  });
  
  test("should process valid text message, generate/insert embeddings, and reply", async () => {
      const messageText = "This is a test message";
      const chatId = 987654321;
      const messageId = 555;
      const date = Math.floor(Date.now() / 1000);
      const webhookBody = { update_id: 12345, message: { message_id: messageId, chat: { id: chatId, type: "private" }, date: date, text: messageText, from: { id: 111, is_bot: false, first_name: "Test" }, }, };
      const request = new Request(`https://telegram-worker.workers.dev${WEBHOOK_ENDPOINT}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET, }, body: JSON.stringify(webhookBody), });
      const response = await telegramWorker.fetch(request, mockEnv as unknown as WorkerEnv);
      expect(response.status).toBe(200); 
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mockAiRun).toHaveBeenCalledTimes(1);
      expect(mockAiRun).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: [messageText] }); 
      expect(mockVectorizeInsert).toHaveBeenCalledTimes(1);
      const insertArgs = mockVectorizeInsert.mock.calls[0][0];
      expect(insertArgs).toHaveLength(1);
      expect(insertArgs[0].id).toBe(String(messageId));
      expect(insertArgs[0].values).toEqual([0.1]); 
      expect(insertArgs[0].metadata).toEqual(expect.objectContaining({ messageId: String(messageId), chatId: String(chatId), text: messageText, timestamp: expect.any(String), }));
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchCallArgs = mockFetch.mock.calls[0];
      expect(fetchCallArgs[0]).toContain(`https://api.telegram.org/bot${TEST_BOT_TOKEN}/sendMessage`);
      const fetchBody = JSON.parse(fetchCallArgs[1].body);
      expect(fetchBody.chat_id).toBe(chatId);
      expect(fetchBody.text).toContain("Received your message"); 
  });
});

import { Errors, toError } from "@jango-blockchained/hoox-shared/errors";
import {
  generateEmbeddings,
  queryEmbeddings,
  insertEmbeddings,
  TelegramMessageMetadata,
  VectorizeMatches,
} from "../logic/rag";
import {
  sendTelegramReply,
  handleGetLatestTradeSignalR2,
} from "../logic/telegram";

/**
 * Handles incoming requests from the Telegram webhook.
 */
export async function handleWebhookRequest(
  request: Request,
  env: any,
  logger: any
): Promise<Response> {
  // 1. Security Check
  const secretToken = env.TELEGRAM_SECRET_TOKEN;
  const receivedToken = request.headers.get("X-Telegram-Bot-Api-Secret-Token");

  if (secretToken && receivedToken !== secretToken) {
    logger.warn("Invalid or missing Telegram secret token received.");
    return Errors.unauthorized();
  }

  // 2. Parse Telegram Update
  let update: {
    message?: {
      message_id: number;
      from?: { id: number };
      chat: { id: number };
      text?: string;
      date: number;
    };
    edited_message?: {
      message_id: number;
      from?: { id: number };
      chat: { id: number };
      text?: string;
      date: number;
    };
  };
  try {
    update = await request.json();
    logger.info("Received Telegram update", { update });
  } catch (error: unknown) {
    logger.error("Failed to parse Telegram update JSON", {
      error: toError(error),
    });
    return Errors.badRequest("Invalid JSON");
  }

  const message = update.message || update.edited_message;
  if (
    !message ||
    !message.text ||
    !message.chat ||
    !message.chat.id ||
    !message.message_id
  ) {
    logger.info(
      "Received update without a usable message/chat context. Skipping."
    );
    return new Response("OK", { status: 200 });
  }

  const chatId = message.chat.id;
  const messageText = message.text.trim();
  const messageId = String(message.message_id);
  const senderId = message.from?.id ? String(message.from.id) : undefined;

  // 3. Command Handling & Processing
  try {
    if (messageText.startsWith("/search ")) {
      const query = messageText.substring(8).trim();
      if (!query) {
        await sendTelegramReply(
          chatId,
          "Please provide a search term after /search.",
          env,
          logger
        );
      } else {
        logger.info(`Processing /search command with query: "${query}"`);
        const searchResults = await queryEmbeddings(query, env, logger, 5);

        let replyText = `Found ${searchResults.matches.length} results for "_${query}_":\n\n`;
        if (searchResults.matches.length > 0) {
          searchResults.matches.forEach((match, index) => {
            const originalText =
              (match.metadata?.text as string) || "(No text found)";
            const escapedText = originalText.replace(
              /([_*[\\]()~`>#+\\-=|{}.!])/g,
              "\\$1"
            );
            replyText += `${index + 1}. (${match.score.toFixed(3)}) ${escapedText}\n`;
          });
        } else {
          replyText = `No results found for "_${query}_."`;
        }
        await sendTelegramReply(chatId, replyText, env, logger);
      }
    } else if (messageText === "/latest") {
      logger.info("Processing /latest command...");
      const latestSignalObject = await handleGetLatestTradeSignalR2(
        env,
        logger
      );
      if (latestSignalObject) {
        try {
          const text = await new Response(latestSignalObject.body).text();
          const signalData = JSON.parse(text);
          const formattedSignal = JSON.stringify(signalData, null, 2).replace(
            /([_*[\\]()~`>#+\\-=|{}.!])/g,
            "\\$1"
          );
          await sendTelegramReply(
            chatId,
            `*Latest Trade Signal:*\n\`\`\`json\n${formattedSignal}\n\`\`\``,
            env,
            logger
          );
        } catch (parseError: unknown) {
          logger.error("Failed to parse latest signal JSON", {
            error: toError(parseError),
          });
          await sendTelegramReply(
            chatId,
            "Error: Could not read the latest signal data.",
            env,
            logger
          );
        }
      } else {
        await sendTelegramReply(
          chatId,
          "Could not find any recent trade signals.",
          env,
          logger
        );
      }
    } else if (messageText.startsWith("/ask ")) {
      const question = messageText.substring(5).trim();
      if (!question) {
        await sendTelegramReply(
          chatId,
          "Please provide a question after /ask\\.",
          env,
          logger
        );
      } else {
        logger.info(`Processing /ask command with question: "${question}"`);
        await sendTelegramReply(
          chatId,
          `_Searching message history for context related to "${question}".`,
          env,
          logger
        );

        let searchResults: VectorizeMatches | null = null;
        try {
          searchResults = await queryEmbeddings(question, env, logger, 5);
        } catch (vectorError: unknown) {
          logger.error("Error querying Vectorize during /ask", {
            error: toError(vectorError),
          });
          await sendTelegramReply(
            chatId,
            "Sorry, I encountered an error searching the message history\\. Please try again later\\.",
            env,
            logger
          );
          return new Response("OK", { status: 200 });
        }

        const contextTexts = searchResults.matches
          .map((match) => match.metadata?.text as string)
          .filter((text) => !!text);

        if (contextTexts.length === 0) {
          await sendTelegramReply(
            chatId,
            `Couldn't find relevant context for "${question}". Try asking differently or indexing more messages.`,
            env,
            logger
          );
        } else {
          const MAX_CONTEXT_LENGTH = 3000;
          let currentLength = 0;
          const limitedContext: string[] = [];
          for (const text of contextTexts) {
            if (currentLength + text.length < MAX_CONTEXT_LENGTH) {
              limitedContext.push(text);
              currentLength += text.length;
            } else {
              break;
            }
          }

          const contextString = limitedContext
            .map((text, i) => `Context ${i + 1}: ${text}`)
            .join("\\n-----\\n");

          const systemPrompt =
            "You are a helpful assistant\\. Answer the user's question based *ONLY* on the provided context snippets from previous messages\\. If the context does not contain the answer, clearly state that you cannot answer based on the provided information\\. Do not add any information not present in the context\\.";
          const userPrompt = `CONTEXT:\n${contextString}\n\nQUESTION: ${question}`;

          await sendTelegramReply(
            chatId,
            `_Found ${limitedContext.length} relevant message snippets\\! Asking the AI\\.\\.\\._`,
            env,
            logger
          );
          logger.info(
            `Sending RAG prompt to AI (Context length: ${currentLength} chars):\nSystem: ${systemPrompt}\nUser: ${userPrompt}`
          );

          let aiResponse: { response: string };
          try {
            aiResponse = (await env.AI.run("@cf/meta/llama-3-8b-instruct", {
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
            })) as { response: string };
          } catch (aiError: unknown) {
            logger.error("Error calling AI during /ask", {
              error: toError(aiError),
            });
            await sendTelegramReply(
              chatId,
              "Sorry, I encountered an error asking the AI\\. Please try again later\\.",
              env,
              logger
            );
            return new Response("OK", { status: 200 });
          }

          const replyText = aiResponse.response.replace(
            /([_*[\\]()~`>#+\\-=|{}.!])/g,
            "\\$1"
          );
          await sendTelegramReply(chatId, replyText, env, logger);
        }
      }
    } else {
      logger.info(`Indexing message: "${messageText}"`);
      const embeddings = await generateEmbeddings(messageText, env, logger);
      const metadata: TelegramMessageMetadata = {
        messageId: messageId,
        chatId: String(chatId),
        senderId: senderId,
        timestamp: message.date
          ? new Date(message.date * 1000).toISOString()
          : new Date().toISOString(),
        text: messageText,
      };
      await insertEmbeddings(embeddings, [metadata], env, logger);
    }

    return new Response("OK", { status: 200 });
  } catch (error: unknown) {
    logger.error("Error processing Telegram message", {
      error: toError(error),
    });
    try {
      await sendTelegramReply(
        chatId || "unknown_chat",
        `An internal error occurred while processing your request.`,
        env,
        logger
      );
    } catch (sendError: unknown) {
      logger.error("Failed to send error notification to user", {
        error: toError(sendError),
      });
    }
    return new Response("OK", { status: 200 });
  }
}

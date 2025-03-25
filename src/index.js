// telegram-worker/src/index.js - Only accepts requests from the webhook receiver
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // Verify internal service authentication
  const internalKey = request.headers.get('X-Internal-Key');
  const requestId = request.headers.get('X-Request-ID');
  
  if (!internalKey || internalKey !== INTERNAL_SERVICE_KEY || !requestId) {
    return new Response(JSON.stringify({ 
      success: false, 
      error: 'Unauthorized' 
    }), { status: 403 });
  }
  
  try {
    const data = await request.json();
    const { chatId = TELEGRAM_CHAT_ID, message } = data;
    
    if (!message) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing message parameter'
      }), { status: 400 });
    }
    
    // Send Telegram message
    const telegramResponse = await sendTelegramMessage(chatId, message);
    
    return new Response(JSON.stringify({
      success: true,
      requestId,
      telegramResponse
    }));
    
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    
    return new Response(JSON.stringify({
      success: false,
      error: error.message || 'Unknown error occurred'
    }), { status: 500 });
  }
}

async function sendTelegramMessage(chatId, message) {
  const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(telegramApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Telegram API error: ${error}`);
  }

  return response.json();
}

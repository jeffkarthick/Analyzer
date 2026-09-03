import crypto from "crypto";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Keep each request comfortably below the 8K TPM limit.
const CHUNK_CHARS = 18000;

// Maximum number of characters accepted from one WhatsApp export.
const MAX_CHAT_CHARS = 200000;

function createChatHash(chatText, exName) {
  return crypto
    .createHash("sha256")
    .update(`${exName || ""}|${chatText}`)
    .digest("hex");
}

async function redisCommand(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Upstash Redis environment variables are missing.");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error ||
      data?.message ||
      "Upstash request failed."
    );
  }

  return data.result;
}

async function getCachedAnalysis(hash) {
  return await redisCommand([
    "GET",
    `chatback:analysis:${hash}`
  ]);
}

async function saveCachedAnalysis(hash, result) {
  // Cache for 30 days.
  await redisCommand([
    "SET",
    `chatback:analysis:${hash}`,
    JSON.stringify(result),
    "EX",
    "2592000"
  ]);
}

async function askGroq(prompt, maxTokens = 700) {
  const response = await fetch(GROQ_URL, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      model: "openai/gpt-oss-20b",

      messages: [
        {
          role: "system",
          content:
            "You are CHATBACK, a neutral WhatsApp relationship chat analyzer. Infer patterns only from the text. Never claim certainty about private feelings."
        },
        {
          role: "user",
          content: prompt
        }
      ],

      temperature: 0.4,
      max_tokens: maxTokens
    })
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("GROQ ERROR:", data);

    throw new Error(
      data?.error?.message ||
      "Groq request failed."
    );
  }

  const result =
    data?.choices?.[0]?.message?.content;

  if (!result) {
    throw new Error("Groq returned an empty response.");
  }

  return result;
}

function splitChat(chatText) {
  const chunks = [];

  for (
    let i = 0;
    i < chatText.length;
    i += CHUNK_CHARS
  ) {
    chunks.push(
      chatText.slice(i, i + CHUNK_CHARS)
    );
  }

  return chunks;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const {
      exName,
      chatText,
      premium = false
    } = req.body || {};

    // -----------------------------
    // ENV CHECK
    // -----------------------------

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is missing."
      });
    }

    if (
      !process.env.UPSTASH_REDIS_REST_URL ||
      !process.env.UPSTASH_REDIS_REST_TOKEN
    ) {
      return res.status(500).json({
        error:
          "Upstash Redis environment variables are missing."
      });
    }

    // -----------------------------
    // CHAT VALIDATION
    // -----------------------------

    if (
      !chatText ||
      typeof chatText !== "string" ||
      chatText.trim().length < 20
    ) {
      return res.status(400).json({
        error: "Please provide a WhatsApp chat."
      });
    }

    const cleanChat = chatText.trim();

    if (cleanChat.length > MAX_CHAT_CHARS) {
      return res.status(400).json({
        error:
          "This WhatsApp chat is too large. Please upload a smaller export."
      });
    }

    // -----------------------------
    // CREATE UNIQUE HASH
    // -----------------------------

    const chatHash = createChatHash(
      cleanChat,
      exName
    );

    // -----------------------------
    // CHECK UPSTASH
    // -----------------------------

    const cached = await getCachedAnalysis(
      chatHash
    );

    if (cached) {
      console.log("CACHE HIT:", chatHash);

      const parsed =
        typeof cached === "string"
          ? JSON.parse(cached)
          : cached;

      return res.status(200).json({
        success: true,
        cached: true,
        result: parsed.result,
        chunks: parsed.chunks || 0
      });
    }

    console.log("CACHE MISS:", chatHash);

    // -----------------------------
    // SPLIT CHAT
    // -----------------------------

    const chunks = splitChat(cleanChat);

    console.log(
      `Analysing ${chunks.length} chunks`
    );

    const chunkResults = [];

    // -----------------------------
    // ANALYSE EACH CHUNK
    // -----------------------------

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const prompt = `
You are analysing PART ${i + 1} of ${chunks.length}
of a WhatsApp conversation.

Person being analysed:
${exName || "Unknown"}

Extract useful relationship patterns from this section.

Focus on:
- Who initiates
- Emotional tone
- Interest/engagement indicators
- Communication style
- Positive signs
- Negative signs
- Important changes in behaviour
- Evidence from the conversation

Do NOT make absolute claims about someone's private feelings.

Return concise structured notes.

CHAT PART:

${chunk}
`;

      const result = await askGroq(
        prompt,
        600
      );

      chunkResults.push(result);
    }

    // -----------------------------
    // FINAL ANALYSIS
    // -----------------------------

    const combinedNotes =
      chunkResults.join("\n\n--- NEXT PART ---\n\n");

    // Protect final request size.
    const finalNotes =
      combinedNotes.slice(0, 30000);

    const finalPrompt = `
You are CHATBACK.

Create the final relationship analysis using
the notes extracted from multiple sections of
a WhatsApp conversation.

Person being analysed:
${exName || "Unknown"}

Provide:

1. Relationship summary
2. Who appears to initiate more
3. Emotional tone
4. Main communication pattern
5. Overall connection score /100
6. Who appears more emotionally invested and why
7. Attachment indicators
8. Red flags
9. Green flags
10. Communication compatibility
11. Detailed relationship insight
12. Suggested next reply
13. Final takeaway

Important:
- These are patterns inferred from text.
- Never claim certainty about someone's private feelings.
- Do not invent facts.
- Be realistic and emotionally neutral.
- Use headings and bullet points.

ANALYSIS NOTES:

${finalNotes}
`;

    const finalResult = await askGroq(
      finalPrompt,
      premium ? 1600 : 900
    );

    // -----------------------------
    // SAVE TO UPSTASH
    // -----------------------------

    const cacheData = {
      result: finalResult,
      chunks: chunks.length,
      createdAt: new Date().toISOString()
    };

    await saveCachedAnalysis(
      chatHash,
      cacheData
    );

    // -----------------------------
    // RETURN
    // -----------------------------

    return res.status(200).json({
      success: true,
      cached: false,
      result: finalResult,
      chunks: chunks.length
    });

  } catch (error) {
    console.error("CHATBACK ERROR:", error);

    return res.status(500).json({
      error:
        error?.message ||
        "Server error. Please try again."
    });
  }
}
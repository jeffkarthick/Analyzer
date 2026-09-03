import crypto from "crypto";

const GROQ_URL =
  "https://api.groq.com/openai/v1/chat/completions";

// Safe chunk size.
// Character count is NOT the same as token count.
const CHUNK_CHARS = 10000;

// Maximum output for each chunk
const CHUNK_MAX_TOKENS = 500;

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
    throw new Error(
      "Upstash Redis environment variables are missing."
    );
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
  await redisCommand([
    "SET",
    `chatback:analysis:${hash}`,
    JSON.stringify(result),
    "EX",
    "2592000"
  ]);
}

async function askGroq(prompt, maxTokens) {
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
            "You are CHATBACK, a neutral WhatsApp relationship chat analyzer. Only infer patterns from the provided text."
        },
        {
          role: "user",
          content: prompt
        }
      ],

      temperature: 0.3,
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
    throw new Error(
      "Groq returned an empty response."
    );
  }

  return result;
}


// ----------------------------------------
// SMART CHAT SPLITTER
// ----------------------------------------

function splitChat(chatText) {
  const lines = chatText.split(/\r?\n/);

  const chunks = [];
  let current = "";

  for (const line of lines) {
    if (
      current.length + line.length + 1 >
      CHUNK_CHARS
    ) {
      if (current.trim()) {
        chunks.push(current);
      }

      current = line;
    } else {
      current += line + "\n";
    }
  }

  if (current.trim()) {
    chunks.push(current);
  }

  return chunks;
}


// ----------------------------------------
// MAIN HANDLER
// ----------------------------------------

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


    // ----------------------------------------
    // ENVIRONMENT CHECK
    // ----------------------------------------

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


    // ----------------------------------------
    // CHAT CHECK
    // ----------------------------------------

    if (
      !chatText ||
      typeof chatText !== "string" ||
      chatText.trim().length < 20
    ) {
      return res.status(400).json({
        error:
          "Please provide a WhatsApp chat."
      });
    }

    const cleanChat = chatText.trim();


    // ----------------------------------------
    // HASH
    // ----------------------------------------

    const chatHash = createChatHash(
      cleanChat,
      exName
    );


    // ----------------------------------------
    // CHECK UPSTASH
    // ----------------------------------------

    const cached =
      await getCachedAnalysis(chatHash);

    if (cached) {
      console.log(
        "CHATBACK CACHE HIT:",
        chatHash
      );

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


    // ----------------------------------------
    // SPLIT
    // ----------------------------------------

    const chunks = splitChat(cleanChat);

    console.log(
      "CHATBACK TOTAL CHUNKS:",
      chunks.length
    );


    // ----------------------------------------
    // ANALYSE CHUNKS
    // ----------------------------------------

    const chunkResults = [];

    for (
      let i = 0;
      i < chunks.length;
      i++
    ) {
      console.log(
        `Analysing chunk ${i + 1}/${chunks.length}`
      );

      const prompt = `
You are analysing part ${i + 1} of ${
        chunks.length
      } of a WhatsApp conversation.

Person:
${exName || "Unknown"}

Find useful relationship patterns.

Analyse:

- Who initiates
- Emotional tone
- Interest and engagement
- Communication style
- Positive signs
- Negative signs
- Changes in behaviour
- Important relationship signals

Do not claim certainty about private feelings.

Return concise notes.

WHATSAPP CHAT PART:

${chunks[i]}
`;

      const result = await askGroq(
        prompt,
        CHUNK_MAX_TOKENS
      );

      chunkResults.push(result);

      // Small delay to reduce rate-limit problems.
      if (i < chunks.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1200)
        );
      }
    }


    // ----------------------------------------
    // COMBINE NOTES
    // ----------------------------------------

    const combinedNotes =
      chunkResults.join(
        "\n\n--- NEXT CHAT PART ---\n\n"
      );


    // ----------------------------------------
    // FINAL ANALYSIS
    // ----------------------------------------

    const finalPrompt = `
You are CHATBACK.

Create the final relationship analysis from
the notes collected from the entire WhatsApp chat.

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

Rules:

- Infer patterns only from the text.
- Never claim certainty about private feelings.
- Never invent facts.
- Be realistic.
- Use headings and bullet points.

CHAT ANALYSIS NOTES:

${combinedNotes}
`;

    const finalResult = await askGroq(
      finalPrompt,
      premium ? 1600 : 900
    );


    // ----------------------------------------
    // SAVE TO UPSTASH
    // ----------------------------------------

    await saveCachedAnalysis(
      chatHash,
      {
        result: finalResult,
        chunks: chunks.length,
        createdAt:
          new Date().toISOString()
      }
    );


    // ----------------------------------------
    // RESPONSE
    // ----------------------------------------

    return res.status(200).json({
      success: true,
      cached: false,
      result: finalResult,
      chunks: chunks.length
    });

  } catch (error) {
    console.error(
      "CHATBACK ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Server error. Please try again."
    });
  }
}
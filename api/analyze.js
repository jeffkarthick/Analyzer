import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { exName, chatText } = req.body || {};

    if (!chatText || String(chatText).trim().length < 20) {
      return res.status(400).json({
        error: "Please provide a WhatsApp chat."
      });
    }

    const groqKey = process.env.GROQ_API_KEY;
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!groqKey) {
      return res.status(500).json({
        error: "GROQ_API_KEY is missing in Vercel."
      });
    }

    if (!redisUrl || !redisToken) {
      return res.status(500).json({
        error: "Upstash Redis environment variables are missing."
      });
    }

    // ---------------------------------------
    // UPSTASH REDIS
    // ---------------------------------------

    async function redisCommand(command) {
      const response = await fetch(redisUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${redisToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(command)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data?.error || "Redis request failed."
        );
      }

      return data?.result;
    }

    // ---------------------------------------
    // CLEAN CHAT
    // ---------------------------------------

    const cleanChat = String(chatText)
      .replace(/\r/g, "")
      .trim();

    // ---------------------------------------
    // CREATE CHAT HASH
    // ---------------------------------------

    const chatHash = crypto
      .createHash("sha256")
      .update(cleanChat)
      .digest("hex");

    const cacheKey = `chatback:free:${chatHash}`;

    // ---------------------------------------
    // CHECK CACHE
    // ---------------------------------------

    const cachedResult = await redisCommand([
      "GET",
      cacheKey
    ]);

    if (cachedResult) {
      return res.status(200).json({
        success: true,
        result: cachedResult,
        cached: true
      });
    }

    // ---------------------------------------
    // SMART CHAT COMPRESSION
    // ---------------------------------------

    function smartCompressChat(text) {
      const MAX_CHARS = 10000;

      if (text.length <= MAX_CHARS) {
        return text;
      }

      let lines = text
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

      // Remove common WhatsApp system/media lines
      lines = lines.filter(line => {
        const lower = line.toLowerCase();

        if (
          lower.includes("messages and calls are end-to-end encrypted")
        ) {
          return false;
        }

        if (
          lower.includes("<media omitted>")
        ) {
          return false;
        }

        if (
          lower.includes("image omitted")
        ) {
          return false;
        }

        if (
          lower.includes("video omitted")
        ) {
          return false;
        }

        if (
          lower.includes("audio omitted")
        ) {
          return false;
        }

        if (
          lower.includes("sticker omitted")
        ) {
          return false;
        }

        return true;
      });

      if (lines.length === 0) {
        return text.slice(0, MAX_CHARS);
      }

      /*
        Take messages from:
        - beginning
        - middle
        - end

        This keeps relationship history balanced.
      */

      const selected = [];

      const firstCount = Math.floor(lines.length * 0.30);
      const middleCount = Math.floor(lines.length * 0.40);
      const lastCount = Math.floor(lines.length * 0.30);

      // Beginning
      for (let i = 0; i < firstCount; i++) {
        selected.push(lines[i]);
      }

      // Middle
      const middleStart = Math.floor(
        (lines.length - middleCount) / 2
      );

      for (
        let i = middleStart;
        i < middleStart + middleCount;
        i++
      ) {
        if (lines[i]) {
          selected.push(lines[i]);
        }
      }

      // End
      for (
        let i = Math.max(
          0,
          lines.length - lastCount
        );
        i < lines.length;
        i++
      ) {
        selected.push(lines[i]);
      }

      // Remove duplicates
      const uniqueLines = [
        ...new Set(selected)
      ];

      let result = "";

      for (const line of uniqueLines) {
        if (
          result.length + line.length + 1 >
          MAX_CHARS
        ) {
          break;
        }

        result += line + "\n";
      }

      return `
[CHAT COMPRESSED LOCALLY]

The original WhatsApp chat was large.
A representative sample was selected from the
beginning, middle and end of the conversation.

Do not assume missing parts of the conversation.

${result}
`;
    }

    const compressedChat =
      smartCompressChat(cleanChat);

    // ---------------------------------------
    // GROQ - ONLY ONE REQUEST
    // ---------------------------------------

    const prompt = `
You are CHATBACK, an AI relationship chat analyzer.

Person being analyzed:
${exName || "Unknown"}

Analyze the WhatsApp conversation below.

IMPORTANT RULES:

- Analyze only what is visible in the conversation.
- Never claim to know someone's private thoughts.
- Never say something is 100% certain.
- Use phrases like "the conversation suggests".
- Do not invent events or facts.
- If evidence is insufficient, say so.
- Be emotionally neutral.
- Keep the answer easy to read.

Provide:

1. 💬 Relationship Summary
Give a short summary of the overall communication.

2. 📱 Who Initiates More
Explain who appears to start conversations more often.

3. ❤️ Emotional Tone
Describe the overall emotional tone.

4. 🔥 Interest Signals
Mention signs of interest or engagement visible in the chat.

5. 🚩 Red Flags
Mention communication patterns that could be concerning.

6. 💚 Green Flags
Mention positive communication patterns.

7. 🧠 Communication Pattern
Explain how both people communicate with each other.

8. 💯 Connection Score
Give a score from 0-100 based only on the conversation.

9. 🔍 Final Takeaway
Give a short honest conclusion.

Use headings and bullet points.

Do not make the response extremely long.

WHATSAPP CHAT:

${compressedChat}
`;

    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${groqKey}`,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          model: "openai/gpt-oss-20b",

          messages: [
            {
              role: "system",
              content:
                "You are CHATBACK. Analyze WhatsApp conversations clearly, neutrally and concisely."
            },
            {
              role: "user",
              content: prompt
            }
          ],

          temperature: 0.5,

          max_tokens: 650
        })
      }
    );

    const data = await groqResponse.json();

    // ---------------------------------------
    // GROQ ERROR
    // ---------------------------------------

    if (!groqResponse.ok) {
      console.error(
        "Groq Error:",
        data
      );

      if (groqResponse.status === 429) {
        return res.status(429).json({
          error:
            "AI is temporarily busy. Please try again in a few seconds."
        });
      }

      return res.status(groqResponse.status).json({
        error:
          data?.error?.message ||
          "Groq request failed."
      });
    }

    // ---------------------------------------
    // GET RESULT
    // ---------------------------------------

    const result =
      data?.choices?.[0]?.message?.content;

    if (!result) {
      return res.status(502).json({
        error:
          "AI returned an empty response."
      });
    }

    // ---------------------------------------
    // SAVE RESULT
    // 30 DAYS
    // ---------------------------------------

    await redisCommand([
      "SET",
      cacheKey,
      result,
      "EX",
      "2592000"
    ]);

    // ---------------------------------------
    // RESPONSE
    // ---------------------------------------

    return res.status(200).json({
      success: true,
      result,
      cached: false
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
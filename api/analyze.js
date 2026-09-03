import crypto from "crypto";

const GROQ_URL =
  "https://api.groq.com/openai/v1/chat/completions";

const MODEL = "openai/gpt-oss-20b";

// Keep requests safely below Groq 8K token limit.
const CHUNK_CHARS = 9000;

// Number of chunk summaries sent to one group-analysis request.
const GROUP_SIZE = 6;

// Cache for 30 days.
const CACHE_SECONDS = 60 * 60 * 24 * 30;


// ======================================================
// HASH
// ======================================================

function createHash(text, exName) {
  return crypto
    .createHash("sha256")
    .update(`${exName || ""}|${text}`)
    .digest("hex");
}


// ======================================================
// UPSTASH
// ======================================================

async function redis(command) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is missing."
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


// ======================================================
// GROQ
// ======================================================

async function groq(prompt, maxTokens = 600) {
  const response = await fetch(GROQ_URL, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      model: MODEL,

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


// ======================================================
// SPLIT WHATSAPP CHAT
// ======================================================

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
        chunks.push(current.trim());
      }

      current = line + "\n";

    } else {

      current += line + "\n";
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}


// ======================================================
// MAIN
// ======================================================

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


    // ==================================================
    // ENVIRONMENT CHECK
    // ==================================================

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


    // ==================================================
    // CHAT VALIDATION
    // ==================================================

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


    // ==================================================
    // CREATE CHAT HASH
    // ==================================================

    const chatHash = createHash(
      cleanChat,
      exName
    );

    console.log(
      "CHAT HASH:",
      chatHash
    );


    // ==================================================
    // CHECK FINAL CACHE
    // ==================================================

    const finalCacheKey =
      `chatback:final:${chatHash}`;

    const cachedFinal =
      await redis([
        "GET",
        finalCacheKey
      ]);


    // ==================================================
    // CACHE HIT
    // ==================================================

    if (cachedFinal) {

      console.log(
        "FINAL CACHE HIT"
      );

      const parsed =
        typeof cachedFinal === "string"
          ? JSON.parse(cachedFinal)
          : cachedFinal;

      return res.status(200).json({
        success: true,
        cached: true,
        result: parsed.result,
        chunks: parsed.chunks || 0
      });
    }


    // ==================================================
    // SPLIT CHAT
    // ==================================================

    const chunks =
      splitChat(cleanChat);

    console.log(
      "TOTAL CHUNKS:",
      chunks.length
    );


    // ==================================================
    // ANALYSE EACH CHUNK
    // ==================================================

    const chunkSummaries = [];

    for (
      let i = 0;
      i < chunks.length;
      i++
    ) {

      const chunkKey =
        `chatback:chunk:${chatHash}:${i}`;

      // ----------------------------------------------
      // CHECK CHUNK CACHE
      // ----------------------------------------------

      const cachedChunk =
        await redis([
          "GET",
          chunkKey
        ]);


      if (cachedChunk) {

        console.log(
          `CHUNK ${i + 1} CACHE HIT`
        );

        const parsed =
          typeof cachedChunk === "string"
            ? JSON.parse(cachedChunk)
            : cachedChunk;

        chunkSummaries.push(
          parsed.summary
        );

        continue;
      }


      // ----------------------------------------------
      // GROQ CHUNK ANALYSIS
      // ----------------------------------------------

      console.log(
        `ANALYSING CHUNK ${i + 1}/${chunks.length}`
      );

      const prompt = `
You are analysing part ${i + 1} of ${
        chunks.length
      } of a WhatsApp conversation.

Person being analysed:
${exName || "Unknown"}

Extract useful relationship patterns from this
part of the conversation.

Focus on:

- Who initiates conversations
- Who replies more
- Emotional tone
- Interest and engagement
- Communication style
- Affection indicators
- Distance indicators
- Positive signs
- Negative signs
- Important behaviour changes
- Important evidence from the messages

Do NOT claim certainty about private feelings.

Return concise analytical notes that can later
be combined with other parts of the conversation.

CHAT PART:

${chunks[i]}
`;

      const summary =
        await groq(
          prompt,
          500
        );


      // ----------------------------------------------
      // SAVE CHUNK SUMMARY
      // ----------------------------------------------

      await redis([
        "SET",
        chunkKey,
        JSON.stringify({
          summary,
          chunk: i,
          createdAt:
            new Date().toISOString()
        }),
        "EX",
        String(CACHE_SECONDS)
      ]);

      chunkSummaries.push(summary);


      // ----------------------------------------------
      // SMALL DELAY
      // ----------------------------------------------

      if (i < chunks.length - 1) {

        await new Promise(
          resolve =>
            setTimeout(resolve, 1500)
        );
      }
    }


    // ==================================================
    // GROUP SUMMARIES
    // ==================================================

    const groups = [];

    for (
      let i = 0;
      i < chunkSummaries.length;
      i += GROUP_SIZE
    ) {

      groups.push(
        chunkSummaries.slice(
          i,
          i + GROUP_SIZE
        )
      );
    }

    console.log(
      "TOTAL GROUPS:",
      groups.length
    );


    // ==================================================
    // ANALYSE GROUPS
    // ==================================================

    const groupSummaries = [];

    for (
      let i = 0;
      i < groups.length;
      i++
    ) {

      const groupKey =
        `chatback:group:${chatHash}:${i}`;

      // ----------------------------------------------
      // CHECK GROUP CACHE
      // ----------------------------------------------

      const cachedGroup =
        await redis([
          "GET",
          groupKey
        ]);

      if (cachedGroup) {

        console.log(
          `GROUP ${i + 1} CACHE HIT`
        );

        const parsed =
          typeof cachedGroup === "string"
            ? JSON.parse(cachedGroup)
            : cachedGroup;

        groupSummaries.push(
          parsed.summary
        );

        continue;
      }


      // ----------------------------------------------
      // GROUP PROMPT
      // ----------------------------------------------

      const groupText =
        groups[i].join(
          "\n\n--- NEXT SECTION ---\n\n"
        );

      const prompt = `
You are CHATBACK.

You are combining several analysis sections
from the same WhatsApp conversation.

Person:
${exName || "Unknown"}

Identify the larger patterns across these
sections.

Focus on:

- Initiation balance
- Emotional investment indicators
- Communication consistency
- Affection
- Distance
- Conflict
- Interest
- Positive relationship signals
- Negative relationship signals
- Behaviour changes

Do not claim certainty about private feelings.

Return a concise overall relationship summary.

SECTION ANALYSES:

${groupText}
`;

      const summary =
        await groq(
          prompt,
          600
        );


      // ----------------------------------------------
      // SAVE GROUP
      // ----------------------------------------------

      await redis([
        "SET",
        groupKey,
        JSON.stringify({
          summary,
          group: i,
          createdAt:
            new Date().toISOString()
        }),
        "EX",
        String(CACHE_SECONDS)
      ]);

      groupSummaries.push(summary);


      // ----------------------------------------------
      // DELAY
      // ----------------------------------------------

      if (i < groups.length - 1) {

        await new Promise(
          resolve =>
            setTimeout(resolve, 1500)
        );
      }
    }


    // ==================================================
    // FINAL ANALYSIS
    // ==================================================

    const finalNotes =
      groupSummaries.join(
        "\n\n--- NEXT GROUP ---\n\n"
      );


    const finalPrompt = `
You are CHATBACK.

Create the FINAL relationship analysis based
on the complete WhatsApp conversation.

Person being analysed:
${exName || "Unknown"}

Provide:

## 1. Relationship Summary

## 2. Who Initiates More

## 3. Emotional Tone

## 4. Main Communication Pattern

## 5. Connection Score
Give a score from 0 to 100.

## 6. Emotional Investment
Explain who appears more invested based
only on observable conversation patterns.

## 7. Attachment Indicators

## 8. Red Flags

## 9. Green Flags

## 10. Communication Compatibility

## 11. Detailed Relationship Insight

## 12. Suggested Next Reply

## 13. Final Takeaway

IMPORTANT:

- Analyse patterns, not private thoughts.
- Never say you know exactly what someone feels.
- Do not invent information.
- Do not diagnose mental health conditions.
- Be realistic.
- Be emotionally neutral.
- Use readable headings and bullet points.

COMPLETE ANALYSIS NOTES:

${finalNotes}
`;

    const finalResult =
      await groq(
        finalPrompt,
        premium ? 1500 : 900
      );


    // ==================================================
    // SAVE FINAL RESULT
    // ==================================================

    await redis([
      "SET",
      finalCacheKey,
      JSON.stringify({
        result: finalResult,
        chunks: chunks.length,
        groups: groups.length,
        createdAt:
          new Date().toISOString()
      }),
      "EX",
      String(CACHE_SECONDS)
    ]);


    // ==================================================
    // RESPONSE
    // ==================================================

    return res.status(200).json({
      success: true,
      cached: false,
      result: finalResult,
      chunks: chunks.length,
      groups: groups.length
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
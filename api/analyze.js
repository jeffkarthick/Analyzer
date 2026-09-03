export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const { exName, chatText, premium = false } = req.body || {};

    if (!chatText || chatText.trim().length < 20) {
      return res.status(400).json({
        error: "Please provide a WhatsApp chat."
      });
    }

    if (!process.env.GROQ_API_KEY) {
      return res.status(500).json({
        error: "GROQ_API_KEY is missing."
      });
    }

    const prompt = `
You are CHATBACK, an AI relationship chat analyzer.

Person being analyzed:
${exName || "Unknown"}

Analyze the WhatsApp conversation below.

IMPORTANT:
- Never claim you can know someone's private feelings with certainty.
- Infer patterns only from the conversation.
- Be neutral and realistic.
- Do not invent information.

FREE ANALYSIS:

1. Short relationship summary
2. Who appears to initiate more
3. Emotional tone
4. Main communication pattern
5. Overall connection score /100

${
  premium
    ? `
PREMIUM ANALYSIS:

6. Who appears more emotionally invested and why
7. Attachment indicators
8. Red flags
9. Green flags
10. Communication compatibility
11. Detailed relationship insight
12. Suggested next reply
13. Final takeaway
`
    : ""
}

Use clear headings and bullet points.

WhatsApp chat:

${String(chatText).slice(0, 50000)}
`;

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
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
                "You are CHATBACK. Be clear, concise, neutral and helpful."
            },
            {
              role: "user",
              content: prompt
            }
          ],

          temperature: 0.7,

          max_tokens: premium ? 3500 : 1000
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("GROQ ERROR:", data);

      return res.status(response.status).json({
        error:
          data?.error?.message ||
          "Groq request failed."
      });
    }

    const result =
      data?.choices?.[0]?.message?.content;

    if (!result) {
      return res.status(502).json({
        error: "AI returned an empty response."
      });
    }

    return res.status(200).json({
      success: true,
      result
    });

  } catch (error) {
    console.error("SERVER ERROR:", error);

    return res.status(500).json({
      error: error?.message ||
        "Server error. Please try again."
    });
  }
}
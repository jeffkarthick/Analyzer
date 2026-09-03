import React, { useMemo, useState } from "react";

const DEMO_CHAT = `12/08/2026, 9:10 PM - Alex: Hey, how are you?
12/08/2026, 9:12 PM - You: I'm good. What about you?
12/08/2026, 9:13 PM - Alex: Good. I was thinking about you today.
12/08/2026, 9:15 PM - You: Really? 😊
12/08/2026, 9:16 PM - Alex: Yeah, our old conversations came to mind.`;

export default function App() {
  const [exName, setExName] = useState("");
  const [chatText, setChatText] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [premium, setPremium] = useState(false);
  const [paid, setPaid] = useState(false);

  const canAnalyze = useMemo(
    () => exName.trim().length > 0 && chatText.trim().length > 20,
    [exName, chatText]
  );

  function loadDemo() {
    setExName("Alex");
    setChatText(DEMO_CHAT);
    setResult("");
    setError("");
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setChatText(String(reader.result || ""));
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsText(file);
  }

  async function analyze(isPremium = false) {
    if (!exName.trim()) return setError("Enter the person's name first.");
    if (!chatText.trim()) return setError("Paste or upload your WhatsApp chat.");
    setLoading(true);
    setError("");
    setResult("");
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exName: exName.trim(),
          chatText,
          premium: isPremium
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Analysis failed.");
      setResult(data.result || "No result returned.");
      setPremium(isPremium);
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  async function unlockPremium() {
    // Demo gate. Replace this with your server-side Razorpay/Cashfree
    // payment flow before accepting real money.
    const ok = window.confirm(
      "Premium Analysis — ₹49\\n\\nThis demo will unlock the premium UI without charging you.\\nConnect a payment gateway before launch."
    );
    if (!ok) return;
    setPaid(true);
    await analyze(true);
  }

  return (
    <main className="page">
      <nav className="nav">
        <div className="brand"><span>♥</span> CHATBACK</div>
        <button className="ghost" onClick={loadDemo}>Try Demo</button>
      </nav>

      <section className="hero">
        <div className="badge">AI RELATIONSHIP ANALYZER</div>
        <h1>What does your<br /><em>chat</em> really mean?</h1>
        <p className="sub">
          Upload your WhatsApp conversation and discover communication
          patterns, emotional signals and relationship insights.
        </p>
      </section>

      <section className="card">
        <label>1. WHO ARE YOU ANALYZING?</label>
        <input
          value={exName}
          onChange={(e) => setExName(e.target.value)}
          placeholder="Enter their name"
          maxLength={80}
        />

        <label>2. YOUR WHATSAPP CHAT</label>
        <div className="upload">
          <input id="file" type="file" accept=".txt,text/plain" onChange={handleFile} />
          <label htmlFor="file" className="uploadButton">Upload .txt</label>
          <span>or paste your exported WhatsApp chat below</span>
        </div>
        <textarea
          value={chatText}
          onChange={(e) => setChatText(e.target.value)}
          placeholder={"Paste your WhatsApp exported chat here..."}
        />

        {error && <div className="error">{error}</div>}

        <button
          className="primary"
          disabled={!canAnalyze || loading}
          onClick={() => analyze(false)}
        >
          {loading ? "ANALYZING..." : "♥  ANALYZE FOR FREE"}
        </button>

        <p className="privacy">Your API key stays on the Vercel server. Don't upload sensitive information you don't want analyzed.</p>
      </section>

      {result && (
        <section className="result card">
          <div className="resultTop">
            <div>
              <div className="badge">CHATBACK RESULT</div>
              <h2>{premium ? "Your Full Analysis" : "Your Basic Analysis"}</h2>
            </div>
            <div className="scoreDot">♥</div>
          </div>
          <div className="resultText">{result}</div>

          {!premium && !paid && (
            <div className="premium">
              <div>
                <div className="badge">PREMIUM</div>
                <h3>Want the full story?</h3>
                <p>Unlock emotional investment, red flags, green flags, compatibility and suggested replies.</p>
              </div>
              <button className="premiumButton" onClick={unlockPremium}>Unlock — ₹49</button>
            </div>
          )}
        </section>
      )}

      <footer>CHATBACK · AI-generated insights are patterns, not certainty.</footer>
    </main>
  );
}
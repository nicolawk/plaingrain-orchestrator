import express from "express";

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

app.post("/api/pg-assistant-chat", async (req, res) => {
  try {
    const expected = `Bearer ${process.env.AGENT_ORCHESTRATOR_SECRET || ""}`;
    const auth = req.headers.authorization || "";

    if (!process.env.AGENT_ORCHESTRATOR_SECRET) {
      return res.status(500).json({ error: "Missing AGENT_ORCHESTRATOR_SECRET" });
    }

    if (auth !== expected) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { message } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: "message required" });
    }

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are PlainGrain admin assistant." },
          { role: "user", content: message }
        ]
      })
    });

    const data = await openaiRes.json();
    const text = data?.choices?.[0]?.message?.content ?? "";

    return res.json({
      response: text,
      proposals: []
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Orchestrator running on port ${PORT}`);
});

// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import OpenAI from "openai";

dotenv.config();

const { Pool } = pkg;
const app = express();

/* ---------------- BASIC CONFIG ---------------- */

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL missing");
  process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY missing");
  process.exit(1);
}

if (!process.env.AGENT_ORCHESTRATOR_SECRET) {
  console.error("❌ AGENT_ORCHESTRATOR_SECRET missing");
  process.exit(1);
}

/* ---------------- DATABASE ---------------- */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ---------------- OPENAI ---------------- */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SECRET = process.env.AGENT_ORCHESTRATOR_SECRET;

/* ---------------- HEALTH ---------------- */

app.get("/health", async (req, res) => {
  res.json({ ok: true });
});

/* ---------------- SECRET MIDDLEWARE ---------------- */

function verifySecret(req, res, next) {
  const header = req.headers["x-pg-secret"];
  if (!header || header !== SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

/* ---------------- INIT TABLES ---------------- */

async function initTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ingested_events (
        event_id TEXT PRIMARY KEY,
        received_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users_ai (
        user_id TEXT PRIMARY KEY,
        payload JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS listings_ai (
        listing_id TEXT PRIMARY KEY,
        seller_user_id TEXT,
        commodity TEXT,
        price NUMERIC,
        currency TEXT,
        region TEXT,
        payload JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions_ai (
        tx_id TEXT PRIMARY KEY,
        seller_user_id TEXT,
        buyer_user_id TEXT,
        commodity TEXT,
        price NUMERIC,
        currency TEXT,
        region TEXT,
        payload JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("✅ [DB] Tables ready");
  } catch (err) {
    console.error("❌ [DB INIT ERROR]", err);
    process.exit(1);
  }
}

/* ---------------- SYNC USER ---------------- */

app.post("/sync/user", verifySecret, async (req, res) => {
  try {
    const { eventId, user } = req.body;

    if (!eventId || !user?.id) {
      return res.status(400).json({ error: "Missing eventId or user" });
    }

    const existing = await pool.query(
      "SELECT 1 FROM ingested_events WHERE event_id=$1",
      [eventId]
    );

    if (existing.rowCount > 0) {
      return res.json({ skipped: true });
    }

    await pool.query(
      `INSERT INTO users_ai (user_id, payload)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [user.id, user]
    );

    await pool.query("INSERT INTO ingested_events (event_id) VALUES ($1)", [
      eventId,
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("❌ [SYNC USER ERROR]", err);
    res.status(500).json({ error: "Sync failed" });
  }
});

/* ---------------- USER AI CHAT ---------------- */

app.post("/agent/user-chat", verifySecret, async (req, res) => {
  try {
    const { userId, message } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: "Missing userId or message" });
    }

    const listings = await pool.query(
      "SELECT * FROM listings_ai WHERE seller_user_id=$1",
      [userId]
    );

    const transactions = await pool.query(
      "SELECT * FROM transactions_ai WHERE seller_user_id=$1",
      [userId]
    );

    const context = `
You are PlainGrain AI assistant.

User statistics:
Listings: ${listings.rowCount}
Transactions: ${transactions.rowCount}

User message:
${message}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an AI assistant for an agricultural commodities marketplace.",
        },
        { role: "user", content: context },
      ],
      temperature: 0.4,
    });

    res.json({
      response: completion.choices[0].message.content,
      confidence: "high",
    });
  } catch (err) {
    console.error("❌ [CHAT ERROR]", err);
    res.status(500).json({ error: "Assistant failed" });
  }
});

/* ---------------- LISTING AI SUGGEST (DESCRIPTION + PRICE) ---------------- */
/**
 * POST /agent/listing-suggest
 * Headers: x-pg-secret: <AGENT_ORCHESTRATOR_SECRET>
 * Body:
 * {
 *   category, commodity, region, currency, quantity, unit,
 *   language?: "pl"|"en",
 *   specs: {...},
 *   notes?: string  // if user typed something -> AI rewrites it professionally
 * }
 *
 * Returns:
 * {
 *   success: true,
 *   description: string,
 *   priceSuggestion: { value: number, currency: "PLN"|"EUR", unit: "t"|"kg" },
 *   confidence: "low"|"medium"|"high",
 *   missingFields: string[]
 * }
 */
app.post("/agent/listing-suggest", verifySecret, async (req, res) => {
  try {
    const {
      category,
      commodity,
      region,
      currency = "PLN",
      quantity,
      unit = "t",
      language = "pl",
      specs = {},
      notes = "",
    } = req.body;

    if (!category || !commodity) {
      return res.status(400).json({ error: "Missing category or commodity" });
    }

    const userDescription = String(notes || "").trim();
    const hasUserText = userDescription.length >= 10;

    const inputFacts = {
      category,
      commodity,
      region,
      currency,
      quantity,
      unit,
      language,
      specs,
    };

    const systemRewrite = `
You are a professional B2B agricultural commodities copywriter.

Return ONLY valid JSON (no markdown, no extra text):
{
  "description": "string",
  "priceSuggestion": { "value": number, "currency": "PLN|EUR", "unit": "t|kg" },
  "confidence": "low|medium|high",
  "missingFields": ["string", ...]
}

MODE: REWRITE (MANDATORY)
- You MUST rewrite the user's text into professional language (Polish if language="pl", otherwise English).
- Keep meaning, improve grammar, structure, and tone.
- Then enrich it into a complete commercial offer (4–8 sentences).
- Include: general quality sentences + use-cases + short specs summary (1–2 sentences max) + logistics/readiness + region.
- Do NOT invent certifications or guarantees.
- If important info is missing, add it to missingFields (do not guess).
`.trim();

    const systemCreate = `
You are a professional B2B agricultural commodities copywriter.

Return ONLY valid JSON (no markdown, no extra text):
{
  "description": "string",
  "priceSuggestion": { "value": number, "currency": "PLN|EUR", "unit": "t|kg" },
  "confidence": "low|medium|high",
  "missingFields": ["string", ...]
}

MODE: CREATE
- Create a commercial offer description (4–8 sentences), not a spec list.
- Include: 2–3 general sentences about the commodity and suitability, use-cases, a short specs summary (1–2 sentences max), and logistics/readiness + region.
- Do NOT invent certifications or guarantees.
- If important info is missing, add it to missingFields (do not guess).
`.trim();

    const userPromptRewrite = `
Rewrite the following USER_TEXT professionally and enrich it into a full listing offer:

USER_TEXT (rewrite this):
"""
${userDescription}
"""

FACTS (use these only; do not invent):
${JSON.stringify(inputFacts, null, 2)}

Return ONLY JSON.
`.trim();

    const userPromptCreate = `
Create a professional listing description + price suggestion from FACTS:

FACTS:
${JSON.stringify(inputFacts, null, 2)}

Return ONLY JSON.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.45,
      messages: [
        { role: "system", content: hasUserText ? systemRewrite : systemCreate },
        { role: "user", content: hasUserText ? userPromptRewrite : userPromptCreate },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        description: "",
        priceSuggestion: { value: 0, currency, unit },
        confidence: "low",
        missingFields: ["AI returned invalid JSON - try again"],
      };
    }

    // ---- HARDEN OUTPUT (IMPORTANT for Base44) ----
    if (!Array.isArray(parsed.missingFields)) parsed.missingFields = [];

    if (!["low", "medium", "high"].includes(parsed.confidence)) {
      parsed.confidence = "low";
    }

    const ps = parsed.priceSuggestion;
    const psOk =
      ps &&
      typeof ps.value === "number" &&
      Number.isFinite(ps.value) &&
      typeof ps.currency === "string" &&
      typeof ps.unit === "string";

    if (!psOk) {
      parsed.priceSuggestion = { value: 0, currency, unit };
      parsed.confidence = "low";
      parsed.missingFields.push("Price suggestion incomplete");
    }

    if (typeof parsed.description !== "string") {
      parsed.description = "";
      parsed.confidence = "low";
      parsed.missingFields.push("Description missing");
    }

    // Soft sanity: commercial description should not be ultra-short
    if (parsed.description.trim().length < 120) {
      parsed.confidence = "low";
      if (!parsed.missingFields.includes("Description too short")) {
        parsed.missingFields.push("Description too short");
      }
    }
// ✅ Save this suggestion to DB (AI "memory")
const saved = await pool.query(
  `INSERT INTO ai_interactions (user_id, actor, task, input, ai_output)
   VALUES ($1, $2, $3, $4, $5)
   RETURNING id`,
  [
    req.body.userId || null,     // if Base44 sends it later, great
    req.body.actor || "user",    // "user" or "admin"
    "listing_suggest",
    req.body,
    parsed
  ]
);

// attach interactionId so Base44 can send feedback later
const interactionId = saved.rows[0]?.id;

res.json({ success: true, interactionId, ...parsed });
  } catch (err) {
    console.error("❌ [LISTING SUGGEST ERROR]", err);
    res.status(500).json({ error: "Listing suggestion failed" });
  }
});

/* ---------------- START SERVER ---------------- */

async function start() {
  await initTables();

  app.listen(PORT, "0.0.0.0", () => {
    console.log("🚀 [BOOT] Orchestrator running on port", PORT);
  });
}

start();

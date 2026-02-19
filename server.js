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
 *   notes?: string   // if provided and long enough, AI rewrites it professionally
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

    // Treat notes as "user typed description" if long enough -> rewrite mode
    const userDescription = String(notes || "").trim();
    const hasUserText = userDescription.length >= 20;

    const input = {
      category,
      commodity,
      region,
      currency,
      quantity,
      unit,
      language,
      specs,
      userDescription,
      hasUserText,
    };

    const system = `
You are a professional agricultural commodities sales copywriter for the EU/Poland B2B market.

Return ONLY valid JSON (no markdown, no extra text).

JSON format:
{
  "description": "string",
  "priceSuggestion": { "value": number, "currency": "PLN|EUR", "unit": "t|kg" },
  "confidence": "low|medium|high",
  "missingFields": ["string", ...]
}

DESCRIPTION RULES:
- Write in Polish if language="pl", otherwise English.
- The description MUST be 4–8 sentences and read like a real commercial offer (not just specs).
- Always include:
  1) 2–3 general sentences about the commodity, quality, and market suitability (easy to read)
  2) suggested use-cases matching the commodity (e.g., milling / feed / processing / export)
  3) short specs summary (1–2 sentences max; weave numbers naturally, do not bullet-list)
  4) logistics/storage readiness (availability, loading, storage conditions, region/location)
- If hasUserText=true, rewrite userDescription professionally first (keep meaning), then enrich it into a full B2B offer and incorporate key specs.

STRICT:
- Do NOT invent certifications, guarantees, lab results, origin claims, or “certified” statements unless explicitly present in input.
- If an important detail is missing (e.g., exact grade, delivery terms), do not guess—add it to missingFields.
`.trim();

    const user = `
TASK:
Create:
1) listing description (commercial offer)
2) price suggestion (per unit)

INPUT:
${JSON.stringify(input, null, 2)}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.45, // higher for better copywriting, still stable
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
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

    // missingFields must always be an array
    if (!Array.isArray(parsed.missingFields)) {
      parsed.missingFields = [];
    }

    // Normalize confidence
    if (!["low", "medium", "high"].includes(parsed.confidence)) {
      parsed.confidence = "low";
    }

    // Ensure priceSuggestion has correct shape
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

    // Ensure description is string
    if (typeof parsed.description !== "string") {
      parsed.description = "";
      parsed.confidence = "low";
      parsed.missingFields.push("Description missing");
    }

    // Soft guard: if AI returned too short description, mark low confidence
    if (parsed.description.trim().length < 140) {
      parsed.confidence = "low";
      if (!parsed.missingFields.includes("Description too short")) {
        parsed.missingFields.push("Description too short");
      }
    }

    res.json({ success: true, ...parsed });
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

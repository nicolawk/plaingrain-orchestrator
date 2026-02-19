// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import OpenAI from "openai";

dotenv.config();

const { Pool } = pkg;

const app = express();

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// --- Env ---
const {
  DATABASE_URL,
  OPENAI_API_KEY,
  AGENT_ORCHESTRATOR_SECRET,
  NODE_ENV,
} = process.env;

// --- Basic env validation (fail fast) ---
function requireEnv(name, value) {
  if (!value) {
    console.error(`[BOOT] Missing required env var: ${name}`);
    process.exit(1);
  }
}
requireEnv("DATABASE_URL", DATABASE_URL);
requireEnv("OPENAI_API_KEY", OPENAI_API_KEY);
requireEnv("AGENT_ORCHESTRATOR_SECRET", AGENT_ORCHESTRATOR_SECRET);

// --- Postgres ---
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Railway Postgres usually needs SSL from outside; inside Railway it can vary.
  // Keeping SSL on with rejectUnauthorized=false is the common quick fix.
  ssl: { rejectUnauthorized: false },
});

// --- OpenAI ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// --- Helpers ---
function getBearerToken(req) {
  const auth = req.headers["authorization"];
  if (!auth || typeof auth !== "string") return null;
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice("Bearer ".length).trim();
}

function verifySecret(req, res, next) {
  // Prefer Authorization: Bearer <secret>, but also accept legacy header x-pg-secret
  const token = getBearerToken(req) || req.headers["x-pg-secret"];
  if (!token || token !== AGENT_ORCHESTRATOR_SECRET) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  next();
}

function safeJson(res, status, payload) {
  res.status(status).json(payload);
}

async function queryOne(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows?.[0] ?? null;
}

/* ---------------- INIT TABLES ---------------- */

async function initTables() {
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

  console.log("[DB] Tables ready");
}

/* ---------------- ROUTES ---------------- */

// Public health (no secret required)
app.get("/health", async (req, res) => {
  safeJson(res, 200, {
    ok: true,
    service: "plaingrain-orchestrator",
    env: NODE_ENV || "unknown",
    time: new Date().toISOString(),
  });
});

// Optional: protected ping to validate secret from Base44
app.get("/health/secure", verifySecret, async (req, res) => {
  safeJson(res, 200, { ok: true });
});

/* ---------------- SYNC USER ----------------
Expected payload:
{
  "eventId": "uuid-or-id",
  "user": { "id": "...", ... }
}
*/
app.post("/sync/user", verifySecret, async (req, res) => {
  try {
    const { eventId, user } = req.body || {};
    if (!eventId || !user?.id) {
      return safeJson(res, 400, { error: "Missing eventId or user.id" });
    }

    const existing = await pool.query(
      "SELECT 1 FROM ingested_events WHERE event_id=$1",
      [eventId]
    );

    if (existing.rowCount > 0) {
      return safeJson(res, 200, { skipped: true });
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

    safeJson(res, 200, { success: true });
  } catch (err) {
    console.error("[/sync/user] Error:", err);
    safeJson(res, 500, { error: "Internal error" });
  }
});

/* ---------------- USER ASSISTANT CHAT ----------------
Expected payload:
{
  "userId": "seller-user-id",
  "message": "text"
}
*/
app.post("/agent/user-chat", verifySecret, async (req, res) => {
  try {
    const { userId, message } = req.body || {};
    if (!userId || !message?.trim()) {
      return safeJson(res, 400, { error: "Missing userId or message" });
    }

    // Pull user profile payload (if exists)
    const userRow = await queryOne("SELECT * FROM users_ai WHERE user_id=$1", [
      userId,
    ]);

    // Pull listings + transactions (keep it light)
    const listings = await pool.query(
      "SELECT listing_id, commodity, price, currency, region, updated_at FROM listings_ai WHERE seller_user_id=$1 ORDER BY updated_at DESC LIMIT 50",
      [userId]
    );

    const transactions = await pool.query(
      "SELECT tx_id, commodity, price, currency, region, buyer_user_id, updated_at FROM transactions_ai WHERE seller_user_id=$1 ORDER BY updated_at DESC LIMIT 200",
      [userId]
    );

    const system = `
You are the PlainGrain User Virtual Assistant.
You help sellers on PlainGrain with:
- Market context (EU prices in EUR/t and Poland in PLN/t for wheat/corn/rapeseed) when available from platform sources
- Their profile performance (listings, conversion, buyers)
- Listing writing (title/description), pricing suggestions, and negotiation tips

Rules:
- If the platform does not have live market prices in the provided context, do NOT claim exact live prices.
- Instead, provide: (1) what you can infer from the user's activity, (2) what data is missing, (3) what to do next (e.g., run daily ingest), and (4) price guidance using bands if provided.
- Be concise, user-friendly, and action-oriented.
`;

    const contextObj = {
      userId,
      profile: userRow?.payload || null,
      listings: listings.rows,
      transactions: transactions.rows,
      note:
        "Market prices are only available if platform ingested them into the orchestrator DB. If missing, explain what needs to be ingested.",
    };

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages: [
        { role: "system", content: system.trim() },
        {
          role: "user",
          content:
            `User message: ${message}\n\nContext (JSON):\n` +
            JSON.stringify(contextObj, null, 2),
        },
      ],
    });

    const answer = completion?.choices?.[0]?.message?.content?.trim() || "";

    safeJson(res, 200, {
      response: answer,
      confidence: "medium",
      // Optional placeholders for your UI:
      cards: [],
      suggestions: [
        "Show my best buyers",
        "Which listings should I improve?",
        "Help me write a better listing description",
        "Suggest a price range for my wheat listing",
      ],
    });
  } catch (err) {
    console.error("[/agent/user-chat] Error:", err);
    // If OpenAI throws useful message, log it, but don't leak details to client
    safeJson(res, 500, { error: "Internal error" });
  }
});

/* ---------------- 404 ---------------- */
app.use((req, res) => {
  safeJson(res, 404, { error: "Not found" });
});

/* ---------------- BOOT ---------------- */
async function boot() {
  try {
    await initTables();
    app.listen(PORT, () => {
      console.log(`[BOOT] Orchestrator running on port ${PORT}`);
    });
  } catch (err) {
    console.error("[BOOT] Failed to start:", err);
    process.exit(1);
  }
}

boot();

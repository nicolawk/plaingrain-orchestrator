import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pkg from "pg";
import OpenAI from "openai";

dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
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
}

initTables();

/* ---------------- SYNC USER ---------------- */

app.post("/sync/user", verifySecret, async (req, res) => {
  const { eventId, user } = req.body;

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

  await pool.query(
    "INSERT INTO ingested_events (event_id) VALUES ($1)",
    [eventId]
  );

  res.json({ success: true });
});

/* ---------------- USER ASSISTANT ---------------- */

app.post("/agent/user-chat", verifySecret, async (req, res) => {
  const { userId, message } = req.body;

  const listings = await pool.query(
    "SELECT * FROM listings_ai WHERE seller_user_id=$1",
    [userId]
  );

  const transactions = await pool.query(
    "SELECT * FROM transactions_ai WHERE seller_user_id=$1",
    [userId]
  );

  const context = `
User has ${listings.rowCount} listings.
User has ${transactions.rowCount} transactions.
User message: ${message}
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are PlainGrain AI assistant." },
      { role: "user", content: context }
    ]
  });

  res.json({
    response: completion.choices[0].message.content,
    confidence: "high"
  });
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

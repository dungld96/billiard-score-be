// app.js
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  // don't exit here so Vercel function can return proper error responses if env missing
}

const supabase = createClient(SUPABASE_URL || "", SUPABASE_KEY || "", {
  auth: { persistSession: false },
});

const app = express();
app.use(cors({
  origin: "*",
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(bodyParser.json());

// Health
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Get all games
app.get("/games", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("games")
      .select()
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// Create a new game
app.post("/games", async (req, res) => {
  try {
    const { max_players = 3, title = null } = req.body;
    if (max_players < 2 || max_players > 5)
      return res.status(400).json({ error: "max_players must be 2..5" });
    const { data, error } = await supabase
      .from("games")
      .insert({ max_players, title })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// Add player to a game
app.post("/games/:id/players", async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });

    const { data: players } = await supabase
      .from("players")
      .select()
      .eq("game_id", id);
    const seat = (players?.length || 0) + 1;
    if (seat > 5)
      return res.status(400).json({ error: "Max players exceeded" });

    const { data, error } = await supabase
      .from("players")
      .insert({ game_id: id, name, seat, score: 0 })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// Start game
app.post("/games/:id/start", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("games")
      .update({ status: "started" })
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// Get game + players + updates
app.get("/games/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { data: game, error: gErr } = await supabase
      .from("games")
      .select()
      .eq("id", id)
      .maybeSingle();
    if (gErr) throw gErr;
    if (!game) return res.status(404).json({ error: "game not found" });

    const { data: players } = await supabase
      .from("players")
      .select()
      .eq("game_id", id)
      .order("seat", { ascending: true });

    const { data: updates } = await supabase
      .from("score_updates")
      .select()
      .eq("game_id", id)
      .order("created_at", { ascending: true });

    res.json({ game, players, updates });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// Update player's score (delta can be negative)
app.post("/games/:id/players/:pid/score", async (req, res) => {
  try {
    const { id, pid } = req.params;
    const { delta = 0, note = null } = req.body;
    if (typeof delta !== "number")
      return res.status(400).json({ error: "delta must be number" });

    const { data: player, error: pErr } = await supabase
      .from("players")
      .select()
      .eq("id", pid)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!player) return res.status(404).json({ error: "player not found" });

    const newScore = (player.score || 0) + delta;
    const { error: uErr } = await supabase
      .from("players")
      .update({ score: newScore })
      .eq("id", pid);
    if (uErr) throw uErr;

    const { error: iErr } = await supabase
      .from("score_updates")
      .insert({ game_id: id, player_id: pid, delta, note });
    if (iErr) throw iErr;

    res.json({ playerId: pid, newScore });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// Undo last update
app.post("/games/:id/undo", async (req, res) => {
  try {
    const { id } = req.params;
    const { data: last } = await supabase
      .from("score_updates")
      .select()
      .eq("game_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!last) return res.status(400).json({ error: "no updates" });

    const { data: player } = await supabase
      .from("players")
      .select()
      .eq("id", last.player_id)
      .maybeSingle();
    const newScore = (player.score || 0) - last.delta;
    await supabase
      .from("players")
      .update({ score: newScore })
      .eq("id", last.player_id);
    await supabase.from("score_updates").delete().eq("id", last.id);

    res.json({ reverted: last.id, playerId: last.player_id, newScore });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// Export the express `app` as the module default so Vercel recognizes it
// Attach `supabase` as a property for convenience in dev/test scenarios
module.exports = app;
module.exports.supabase = supabase;

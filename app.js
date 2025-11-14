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
app.get("/players", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("players")
      .select()
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// Get all games
app.get("/games", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("games")
      .select()
      .order("created_at", { ascending: true });
    if (error) throw error;

    // Fetch players and scores for each game
    const gamesWithPlayers = await Promise.all(
      (data || []).map(async (game) => {
        const { data: gamePlayers } = await supabase
          .from('game_players')
          .select(`
            id,
            seat,
            score,
            players ( id, name )
          `)
          .eq('game_id', game.id)
          .order('seat', { ascending: true });

        return {
          ...game,
          gamePlayers: gamePlayers || []
        };
      })
    );

    res.json(gamesWithPlayers || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});

// Create a new game
app.post("/games", async (req, res) => {
  try {
    const { players = [], title = null } = req.body;

    if (players.length < 2 || players.length > 5) {
      return res.status(400).json({ error: "max_players must be 2..5" });
    }

    if (!Array.isArray(players)) {
      return res.status(400).json({ error: 'players must be an array of UUIDs' });
    }
    // Verify all provided player IDs exist (if any)
    if (players.length > 0) {
      const { data: foundPlayers, error: pErr } = await supabase
        .from('players')
        .select('id')
        .in('id', players);

      if (pErr) throw pErr;
      if (!foundPlayers || foundPlayers.length !== players.length) {
        return res.status(400).json({ error: 'One or more players not found' });
      }
    }

    // 1) Create game
    const { data: game, error: gErr } = await supabase
      .from('games')
      .insert({ title })
      .select()
      .single();

    if (gErr) throw gErr;

    // 2) Insert game_players rows (if any)
    // We'll insert sequentially; if any insert fails, try to cleanup created game & inserted rows
    const insertedGamePlayerIds = [];
    try {
      for (let i = 0; i < players.length; i++) {
        const playerId = players[i];
        const seat = i + 1;
        const { data: gpData, error: gpErr } = await supabase
          .from('game_players')
          .insert({
            game_id: game.id,
            player_id: playerId,
            seat,
            score: 0
          })
          .select()
          .single();
        if (gpErr) throw gpErr;
        insertedGamePlayerIds.push(gpData.id);
      }
    } catch (insertErr) {
      // rollback: delete any inserted game_players for this game, then delete the game
      try {
        await supabase.from('game_players').delete().eq('game_id', game.id);
        await supabase.from('games').delete().eq('id', game.id);
      } catch (cleanupErr) {
        console.error('Failed cleanup after insert error', cleanupErr);
      }
      throw insertErr;
    }

    // 3) Return full game with players
    const { data: gamePlayers } = await supabase
      .from('game_players')
      .select(`
        id,
        seat,
        score,
        players ( id, name )
      `)
      .eq('game_id', game.id)
      .order('seat', { ascending: true });

    return res.json({ game, gamePlayers });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || e });
  }
});


// GET /games/:id
app.get('/games/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'game id required' });

    // 1) Get game
    const { data: game, error: gErr } = await supabase
      .from('games')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (gErr) {
      console.error('Error fetching game:', gErr);
      return res.status(500).json({ error: 'Failed to fetch game' });
    }
    if (!game) return res.status(404).json({ error: 'Game not found' });

    // 2) Get players for the game from join table game_players -> players
    //    We fetch game_players fields (id, seat, score, created_at) and nested players (id, name, avatar_url)
    const { data: gpRows, error: gpErr } = await supabase
      .from('game_players')
      .select(`
        id,
        seat,
        score,
        created_at,
        players:player_id ( id, name )
      `)
      .eq('game_id', id)
      .order('seat', { ascending: true });

    if (gpErr) {
      console.error('Error fetching game_players:', gpErr);
      return res.status(500).json({ error: 'Failed to fetch players for game' });
    }

    // Normalize players array to a nicer shape
    const players = (gpRows || []).map(gp => ({
      game_player_id: gp.id,
      seat: gp.seat,
      score: gp.score,
      joined_at: gp.created_at,
      player: gp.players || null   // nested player's object
    }));

    // 3) Try to fetch score history if table exists (score_updates)
    //    If score_updates doesn't exist, just return empty array.
    let updates = [];
    try {
      // We attempt to select; if table missing, supabase returns error code - we catch it here
      const { data: uRows, error: uErr } = await supabase
        .from('score_updates')
        .select('id, player_id, delta, created_at, note')
        .eq('game_id', id)
        .order('created_at', { ascending: true });

      if (!uErr && uRows) {
        updates = uRows;
      } else if (uErr) {
        // If error indicates table doesn't exist, ignore; otherwise log
        // Supabase PostgREST errors usually have message; log for debugging.
        console.warn('score_updates fetch warning:', uErr.message || uErr);
        updates = [];
      }
    } catch (e) {
      // defensive: if RPC or other error occurs, don't fail whole endpoint
      console.warn('Ignored error while fetching score_updates:', e?.message || e);
      updates = [];
    }

    // 4) Compose and return
    return res.json({
      game,
      players,
      updates
    });
  } catch (e) {
    console.error('GET /games/:id unexpected error', e);
    return res.status(500).json({ error: e.message || 'Internal server error' });
  }
});


// POST /games/:id/round  -- sequential with cleanup on error
app.post('/games/:id/round', async (req, res) => {
  try {
    const { id: gameId } = req.params;
    const { scores, note = null } = req.body;

    if (!Array.isArray(scores) || scores.length === 0) {
      return res.status(400).json({ error: 'scores must be a non-empty array' });
    }

    // validate inputs
    const playerIds = scores.map(s => s.playerId);
    const deltas = scores.map(s => Number(s.delta || 0));
    if (playerIds.some(id => !id)) return res.status(400).json({ error: 'invalid playerId in scores' });

    // verify membership
    const { data: membership, error: memErr } = await supabase
      .from('game_players')
      .select('player_id')
      .eq('game_id', gameId)
      .in('player_id', playerIds);

    if (memErr) throw memErr;
    if (!membership || membership.length !== playerIds.length) {
      return res.status(400).json({ error: 'one or more playerIds are not part of this game' });
    }

    const insertedUpdateIds = [];
    const results = [];

    try {
      for (let i = 0; i < playerIds.length; i++) {
        const pid = playerIds[i];
        const delta = deltas[i];

        // insert into score_updates
        const { data: up, error: upErr } = await supabase
          .from('score_updates')
          .insert({ game_id: gameId, player_id: pid, delta, note })
          .select()
          .single();
        if (upErr) throw upErr;
        insertedUpdateIds.push(up.id);

        // get current score, compute new score, then update
        const { data: cur, error: curErr } = await supabase
          .from('game_players')
          .select('score')
          .eq('game_id', gameId)
          .eq('player_id', pid)
          .maybeSingle();
        if (curErr) throw curErr;
        const newScore = (cur?.score || 0) + delta;
        const { data: gp, error: gpErr } = await supabase
          .from('game_players')
          .update({ score: newScore })
          .eq('game_id', gameId)
          .eq('player_id', pid)
          .select()
          .single();
        if (gpErr) throw gpErr;
        results.push({ playerId: pid, delta, newScore: gp.score });
      }
    } catch (innerErr) {
      // rollback: delete inserted updates and revert scores by subtracting deltas for inserts done so far
      console.error('Error during sequential update, attempting rollback', innerErr);
      try {
        if (insertedUpdateIds.length) {
          await supabase.from('score_updates').delete().in('id', insertedUpdateIds);
        }
        // Recompute revert for those we already applied: for safety, best-effort revert by subtracting applied deltas
        for (let j = 0; j < results.length; j++) {
          const r = results[j];
          await supabase
            .from('game_players')
            .update({ score: (r.newScore - r.delta) })
            .eq('game_id', gameId)
            .eq('player_id', r.playerId);
        }
      } catch (rollbackErr) {
        console.error('Rollback failed', rollbackErr);
      }
      return res.status(500).json({ error: innerErr.message || innerErr });
    }

    return res.json({ success: true, results });
  } catch (e) {
    console.error('POST /games/:id/round error', e);
    return res.status(500).json({ error: e.message || 'Internal server error' });
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

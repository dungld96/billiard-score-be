# billiard-score-be

Backend for Billiard Score app. Express + Supabase.

## Setup (local)

1. Create a Supabase project and run `migrations/init.sql` in the SQL editor.
2. Copy ` .env.example` -> `.env` and fill `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Install & run:
```bash
npm install
npm run dev
# or
npm start

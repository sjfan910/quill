# Turning on accounts & sync (about 20 minutes, once)

Until these steps are done, Quill keeps working exactly as before (this device only, your key in Settings).
Once they're done, the app shows **Continue with Google**, your notes sync across devices, and your Gemini key lives only on the server.

You'll copy values between three places: **Supabase** (database + login), **Google Cloud** (the Google sign-in button), **Vercel** (the server).
Use **`https://www.quillnotetaker.shop`** as the app address below (your custom domain).

---

## 1. Create the database (Supabase, free) · ~5 min

1. Go to [supabase.com](https://supabase.com) → sign in with GitHub or Google → **New project**.
   - Name: `quill` · Region: **East US** (closest to Georgia) · set a database password (save it somewhere; Quill doesn't need it).
2. When it's ready: left sidebar **SQL Editor** → **New query** → paste the whole of [`supabase/schema.sql`](supabase/schema.sql) → **Run**. You should see "Success. No rows returned".
3. **Project Settings → API keys** (or **API**). Keep this tab open; you need:
   - **Project URL**: `https://xxxx.supabase.co`
   - **anon / publishable key**: safe to put in the app
   - **service_role / secret key**: **server only, never share it**

## 2. Make the Google button work (Google Cloud) · ~8 min

Use the same Google Cloud project as your Gemini key (or any project).

1. [Google Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)
   - User type **External** → App name `Quill`, your email as support + developer contact → Save.
   - **Audience / Test users** → add **sjfan910@gmail.com**. (Leaving the app in *Testing* is fine and safer: only test users can sign in.)
2. [Credentials](https://console.cloud.google.com/apis/credentials) → **Create credentials → OAuth client ID** → **Web application**.
   - Authorized JavaScript origins: `https://www.quillnotetaker.shop`
   - Authorized redirect URIs: `https://xxxx.supabase.co/auth/v1/callback` (your Project URL + `/auth/v1/callback`; Supabase shows the exact one in the next step)
   - Create → copy the **Client ID** and **Client secret**.
3. Back in Supabase: **Authentication → Sign In / Providers → Google** → enable → paste Client ID + Client secret → Save.
4. Supabase **Authentication → URL Configuration**:
   - Site URL: `https://www.quillnotetaker.shop`
   - Redirect URLs: add `https://www.quillnotetaker.shop/**` and `https://quill-roan-five.vercel.app/**`

## 3. Give the server its secrets (Vercel) · ~4 min

[Vercel → quill → Settings → Environment Variables](https://vercel.com/sjfan910s-projects/quill/settings/environment-variables). Add each for **Production** and **Preview**:

| Name | Value | Who can see it |
|---|---|---|
| `VITE_SUPABASE_URL` | Supabase Project URL | the app (public, fine) |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon / publishable key | the app (public, fine) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role / secret key | **server only** |
| `GEMINI_API_KEY` | your Gemini API key | **server only** |
| `ALLOWED_EMAILS` | `sjfan910@gmail.com` | server only |
| `HARD_CAP_USD` | `20` (optional; absolute monthly ceiling the server will never exceed) | server only |

Then **Deployments → ⋯ on the latest → Redeploy** (the `VITE_` values are baked in at build time).

## 4. Sign in · 1 min

Open **https://www.quillnotetaker.shop** → **Continue with Google** → pick sjfan910@gmail.com.

- The first sign-in on a device uploads the notes already on it.
- The Gemini key that was saved on that device is wiped (the server's key is used from now on).
- Do the same on your laptop: your classes and notes appear.

---

### What syncs, what doesn't

| Syncs | Stays on the device |
|---|---|
| Classes, lecture notes, mind maps, transcripts, ⭐ marks, class memory, your preferences & note style, model choices, monthly cap, this month's spend | **Audio** (playback only on the phone that recorded it), the loudness log, the raw free-transcript draft |

### If something's off

- **"…isn't allowed to use this Quill"** → the email isn't in `ALLOWED_EMAILS` (or there's a typo). Fix it in Vercel and redeploy.
- **"Quill server is not configured yet"** → one of the server variables is missing; check the table above, then redeploy.
- **Google says "Access blocked" / "app not verified"** → add your email under *Test users* on the consent screen.
- **Sign-in loops back to the login screen** → the app address is missing from Supabase → URL Configuration → Redirect URLs.
- **Long lectures time out** → the server allows 300 s per Gemini call (`vercel.json`). If your Vercel plan rejects that, lower it to 60.
- **Use the custom domain.** Vercel's deployment protection is on for non-custom domains, which can block the server API on `*.vercel.app` preview URLs.

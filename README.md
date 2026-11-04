# Quill

Record a lecture on your iPhone → get visual, exam-focused notes and a mind map. Personal tool, built for low friction.

**Flow:** tap ● → (tap ⭐ when something matters, type quick notes) → tap ■ Finish → notes appear, filed under the class (e.g. `CS 2050 · Lecture 7`). Optionally add slides or feedback to refine, and send to Google Docs.

## How it works
- **Recording:** the browser records the mic to 16 kHz mono MP3 (~14 MB/hour) and saves it to on-device storage (IndexedDB) every 4 seconds. If iOS kills the page, nothing but the last few seconds is lost, and you can tap **Keep recording** to append.
- **Transcript (pass 1, once per lecture):** while recording, the phone's free speech recognition writes a live transcript (beta; turns itself off if it clashes with the mic). After you finish, `src/lib/gaps.ts` compares per-second loudness with the live text and sends **only the stretches the free transcript missed** to Gemini Flash-Lite. Silence before and after class is never sent.
- **Notes (pass 2):** Gemini Flash writes notes + mind map **from the transcript text**, plus the class memory, your preferences and your ⭐ marks. **Improve never re-sends audio.** Thinking is capped; broken replies are retried once.
- **Memory:** each class keeps a ~350-word memory (lectures, glossary, professor habits, deadlines) and Quill learns standing preferences from your Improve feedback. Both update inside the notes call, so they cost nothing extra.
- **Cost:** every call's tokens are logged and priced (estimates); Settings shows this month's spend and a monthly cap (default $5) that blocks automatic runs and asks before manual ones. Pro runs ask first.
- **Storage:** everything (audio, notes, classes) stays on the phone. Your API key is stored locally and only sent to Google.
- **Export:** "Copy & open Google Docs" (zero setup) or, with a Google OAuth client ID in Settings, one-tap save to Drive as a Google Doc.

## iPhone notes
- Install: open the site in Safari → Share → **Add to Home Screen**.
- Web apps can't record with the screen locked. Quill holds the screen awake while recording; dim it and leave it face up.

## Security

- **Key handling:** the Gemini key is stored only on your phone (localStorage) and sent only to Google, in a request header.
- **Untrusted AI output:** notes and mind maps are sanitized before rendering (DOMPurify; raw HTML disabled in markmap).
- **Content-Security-Policy** (`vercel.json`): the page can only load its own scripts and only talk to Google's APIs, so even injected code couldn't send your key elsewhere.

### 2-minute key lockdown (do this once)
1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) and pick the project your AI Studio key lives in.
2. Click your API key.
   - **Application restrictions → Websites** → add `https://YOUR-QUILL-DOMAIN.vercel.app/*`
   - **API restrictions → Restrict key** → tick **Generative Language API** only → Save.
3. [Billing → Budgets & alerts](https://console.cloud.google.com/billing/budgets) → create a budget (e.g. $10/month) with email alerts at 50%, 90%, 100%.
4. If you ever think the key leaked: delete it there, make a new one in [AI Studio](https://aistudio.google.com/apikey), paste it into Quill's Settings.

Note: a website restriction stops other sites from using your key, but someone with a script can fake it, so the budget alert is your real safety net. Budgets alert you; they don't hard-stop spending.

## Develop
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/ (deploy anywhere with HTTPS)
```

Stack: Vite + React + TypeScript, `@google/genai`, `@breezystack/lamejs` (MP3), `markmap`, `idb`, `vite-plugin-pwa`.

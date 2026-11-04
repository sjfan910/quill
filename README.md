# Quill

Record a lecture on your iPhone → get visual, exam-focused notes and a mind map. Personal tool, built for low friction.

**Flow:** tap ● → (tap ⭐ when something matters, type quick notes) → tap ■ Finish → notes appear, filed under the class (e.g. `CS 2050 · Lecture 7`). Optionally add slides or feedback to refine, and send to Google Docs.

## How it works
- **Recording:** the browser records the mic to 16 kHz mono MP3 (~14 MB/hour) and saves it to on-device storage (IndexedDB) every 4 seconds. If iOS kills the page, nothing but the last few seconds is lost, and you can tap **Keep recording** to append.
- **Notes:** the MP3 is uploaded to the Gemini Files API, and one Gemini call returns the class, title, notes (Markdown) and mind map (Markdown → [markmap](https://markmap.js.org)). Prompt lives in `src/lib/gemini.ts`; your personal style lives in Settings.
- **Storage:** everything (audio, notes, classes) stays on the phone. Your API key is stored locally and only sent to Google.
- **Export:** "Copy & open Google Docs" (zero setup) or, with a Google OAuth client ID in Settings, one-tap save to Drive as a Google Doc.

## iPhone notes
- Install: open the site in Safari → Share → **Add to Home Screen**.
- Web apps can't record with the screen locked. Quill holds the screen awake while recording; dim it and leave it face up.

## Develop
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/ (deploy anywhere with HTTPS)
```

Stack: Vite + React + TypeScript, `@google/genai`, `@breezystack/lamejs` (MP3), `markmap`, `idb`, `vite-plugin-pwa`.

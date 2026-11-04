# Quill Roadmap

Ranked from most critical to nice-to-have. Each item names the chat (workstream) that owns it:
**[COST]** = memory + cost-cutting chat · **[CRIT]** = general critiques chat · **[YOU]** = needs the owner (no code).

Prices are rough (third-party trackers, not verified against Google's pricing page). Audio = 32 tokens/sec ≈ 115k tokens per lecture hour.

---

## P0 · Security (do first)

| # | Update | Why | Owner |
|---|---|---|---|
| 1 | ✅ DONE · **Sanitize mind-map output.** markmap renders raw HTML (`html: true`); a malicious mind map read the Gemini key from localStorage in testing. Disable HTML in the markmap transformer and/or DOMPurify node content. | Confirmed key-theft path (low likelihood: needs injected HTML via slides/audio → Gemini). | [CRIT] |
| 2 | ✅ DONE · **Content-Security-Policy via `vercel.json`.** Allow scripts from self (+ `accounts.google.com` for Docs export), `connect-src` only Google APIs. | Turns any future XSS from "steal key" into "nothing". | [CRIT] |
| 3 | ✅ Checklist in README · **Restrict the Gemini API key + budget alert.** Google Cloud Console → key restrictions: Generative Language API only, HTTP referrer = the Vercel domain. Billing → budget alert. | Limits damage if the key ever leaks. | [YOU] (checklist in README by [CRIT]) |

## P0 · Cost (biggest savings)

| # | Update | Why | Owner |
|---|---|---|---|
| 4 | **Transcript-first pipeline.** Pass 1: audio → timestamped transcript (stored locally). Pass 2: transcript → notes + mind map. **Improve uses the transcript, never re-sends audio.** | Improve drops ~$0.12 → ~$0.01. Also enables search/verification. | [COST] |
| 5 | ✅ DONE · **Cap thinking tokens.** Minimal for transcription, low for notes. | Thinking is billed as output and is currently unbounded. | [COST] |
| 6 | **Cost meter + monthly cap.** Read `usageMetadata` per call → "This lecture 5¢ · This month $1.80". Cap (default $5) blocks and asks; confirm before Pro runs. | You see and control spend. | [COST] |
| 7 | **Model routing.** Flash-Lite for transcription, Flash for notes; setting to choose. Validate transcript quality on a real lecture before making it default. | ~40–60% cheaper per lecture. | [COST] |
| 8 | ✅ DONE · **Prompt order static → dynamic** (system prompt, style, memory, then transcript/audio, then marks). | Free implicit-cache hits when they occur; no extra infra. | [COST] |
| 9 | **Trim leading/trailing silence** before upload (not mid-recording, keeps timestamps valid). | ~5–10% fewer audio tokens. | [COST] |

## P1 · Reliability / never lose work

| # | Update | Why | Owner |
|---|---|---|---|
| 10 | **Robust Gemini responses.** Handle truncated/invalid JSON, retry once, readable errors. | Currently a raw parse error. | [COST] (it owns the pipeline) |
| 11 | **Auto-resume unfinished notes** on app reopen; show "keep Quill open ~1 min" while uploading. | iOS kills background web apps; today the job silently dies. | [CRIT] |
| 12 | **Backup to Google Drive** (all notes + transcripts as JSON/Docs), with a periodic reminder. | Everything lives in one phone's browser storage. | [CRIT] |
| 13 | **Real-device test pass:** iPhone home-screen wake lock (iOS 18.4+), 75-min lecture, phone call/Siri interruption, low storage. | Untested on real hardware. | [CRIT] + [YOU] |
| 14 | **Real-lecture prompt eval** with the owner's sample notes; tune the notes prompt. | Note quality is the product and is unproven. | [COST] (prompt) + [YOU] (samples) |

## P2 · Smarter notes (memory)

| # | Update | Why | Owner |
|---|---|---|---|
| 15 | ✅ DONE · **"You" memory** (~300 tokens): durable preferences learned from Improve feedback, editable in Settings. Updated inside the same call (no extra request). | Stop paying to repeat the same feedback. | [COST] |
| 16 | ✅ DONE · **Course memory** (~500–800 tokens per class): lecture one-liners, glossary, professor habits, deadlines. Updated in the notes call, compacted when long. | Continuity ("builds on L6"), consistent jargon, better class detection. ≈0.1¢/lecture. | [COST] |
| 17 | **Learn the class schedule** (weekday + time → preselect class). | Removes the one remaining decision before recording. | [CRIT] |
| 18 | **Version history / undo** for Improve and Remake. | Improve currently overwrites. | [CRIT] |
| 19 | **Transcript view + search** across lectures (after #4). | Verify what was said; find anything. | [CRIT] |

## P3 · Quality of life

| # | Update | Why | Owner |
|---|---|---|---|
| 20 | Mind map included in Google Docs export (as image). | Export is notes-only today. | [CRIT] |
| 21 | Auto-delete audio after 30 days (keep notes + transcript), optional. | ~14 MB/hour → ~1.5 GB per semester. | [CRIT] |
| 22 | "Add to Home Screen" hint on first open in Safari. | Recording works best as an installed app. | [CRIT] |
| 23 | Settings note on free-tier vs paid data use (free tier may be used to improve Google products). | Informed choice. | [CRIT] |
| 24 | Bump/patch low-severity `npm audit` items (katex via markmap). | Hygiene; unused code path. | [CRIT] |

## Later

- "Ask my course" / exam review using local search + only relevant snippets sent to Gemini.
- Flashcards / quick quiz per lecture.

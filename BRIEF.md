# Quill: Project Brief (v0, draft for discussion)

> **One line:** Tap once, and your phone listens to the lecture. When you tap stop, you get organized, visual notes in *your* format: what matters, what to do next, and a mind map.

---

## 1. The problem

Current workflow (≈ 15–30 min of busywork per lecture):

```
Record on phone ──► export audio ──► upload to NotebookLM ──► prompt an AI ──► copy/paste ──► reformat into my style
```

Every step is manual, and the result still isn't in the format I actually study from.

**Goal:** collapse that to:

```
[● Start] ──► (lecture happens, I add quick notes if I want) ──► [■ Stop] ──► notes ready
```

---

## 2. Who it's for

- **Primary user:** me, a student who learns best from **visual, structured, concise** notes (symbols, clear hierarchy, mind maps).
- **Context:** in-person lectures (phone on desk) and online lectures (laptop).

---

## 3. What already exists (and the gap)

| Tool | What it does well | Where it falls short for me |
|---|---|---|
| **Plaud / Pocket** (hardware) | Always-on capture, good summaries | Extra device + subscription; meeting-oriented; summaries aren't study notes |
| **Otter / Notta** | Polished live transcription, multi-language (Notta) | Built for meetings, not learning; no mind maps |
| **Notelyn / NoteGPT / BibiGPT** | Transcript → summary, flashcards, quiz, **mind map** | Mostly **upload-first**, not live; generic format |
| **NotebookLM** | Great reasoning over sources, mind maps | **Upload only**, no recording; needs prompting every time |

**The gap Quill fills:** *live capture* + *my own annotations mid-lecture* + *my personal note style* + *visual output*, all in one tap with zero prompting.

---

## 4. Core features (MVP candidates)

### Capture (must be frictionless)
- **One-tap record**: big button, also reachable from a home-screen/lock-screen shortcut.
- **Keeps recording when the screen is locked**, and survives a weak connection (records locally, uploads later).
- **Live "⭐ Mark" button**: tap when something feels important; the timestamp gets extra weight in the notes.
- **Quick typed add-ons** mid-lecture ("ask prof about X", "this is on the midterm").
- *(stretch)* **Snap a slide/whiteboard photo**: attached at that moment in the timeline.

### Notes output (in my format)
- **TL;DR**: 3–5 bullets.
- **Structured notes**: headings, concise bullets, symbols (→ ⚠️ ✅ 💡 ❓), bolded key terms.
- **🎯 Focus on this**: what the lecturer emphasized, repeated, or flagged as exam-relevant, plus my ⭐ marks.
- **✅ To-dos**: readings, assignments, deadlines mentioned in passing.
- **❓ Gaps**: things that were unclear or worth asking about.
- **🧠 Mind map**: auto-generated, interactive, collapsible.
- **Glossary** of new terms.
- Every point **links back to the audio timestamp**, so I can re-listen.

### Organize
- Auto-tag by course (manual pick, or from calendar later).
- Searchable library of past lectures.
- Export: Markdown / PDF / Notion.

### Later (v2+)
- Flashcards / quick quiz generated from the lecture.
- "Ask this lecture" chat.
- Cross-lecture course summary before exams.

---

## 5. Rough technical shape (to be decided together)

```
 Phone/Laptop app                 Backend                         AI
┌──────────────┐  audio chunks  ┌──────────────┐  transcript   ┌───────────────────┐
│ Record ●     │ ─────────────► │ Store + queue│ ────────────► │ Speech-to-text    │
│ ⭐ marks      │                │              │               └───────────────────┘
│ typed notes  │                │              │  transcript + ┌───────────────────┐
│ photos       │                │              │  marks + style│ LLM: notes, focus,│
└──────────────┘ ◄───────────── └──────────────┘ ◄──────────── │ to-dos, mind map  │
     view notes + mind map                                     └───────────────────┘
```

Key decisions (v1 picks: PWA, Gemini audio understanding direct, markmap):
1. **App type**: PWA (fastest to build, but iOS can stop recording when the screen locks) vs **React Native / Expo** (real background recording, one codebase for iOS + Android) vs native.
2. **Transcription**: cloud API (accurate, cheap per hour, needs internet) vs on-device Whisper (private, offline, heavier on battery).
3. **Note generation**: LLM with a **style profile** built from samples of my own notes.
4. **Mind map**: generate Markdown outline → render with Markmap (or Mermaid for diagrams).

---

## 6. Success criteria

- ≤ **2 taps** from unlocking phone to recording.
- Notes ready **< 2 min** after a 1-hour lecture ends.
- I'd study from the output **without rewriting it**.
- Cost per lecture low enough to use every day.

---

## 7. Risks / considerations

- **Recording consent**: some universities/lecturers require permission to record. App should make this easy to respect.
- **Audio quality** in big halls (distance from speaker).
- **Background recording limits** on iOS (drives the app-type decision).
- **Privacy**: lectures and personal notes stored on a server.

---

## 8. Open questions

See the conversation. Answers will update this brief.

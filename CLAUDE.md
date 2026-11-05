# Instructions for Claude in this repo

## Authorship (owner's standing rule)
All contributions are made under the owner's name, not Claude's.

- Commit as the owner: `git config user.name "sjfan910"` and `git config user.email "sjfan910@gmail.com"` (set them in each new clone before the first commit).
- Do **not** add `Co-Authored-By: Claude …`, `Claude-Session: …` or any other Claude/AI attribution trailer to commit messages.
- Do **not** add "Generated with Claude Code" or similar lines to pull request titles or descriptions.
- Don't rewrite already-pushed history to change authorship unless the owner asks.

## Project
Quill: a personal iPhone PWA that records lectures and turns them into visual notes with Gemini. See `README.md` (how it works) and `ROADMAP.md` (what's done and what's next). Run `npm run build` before pushing; Vercel deploys from the working branch automatically.

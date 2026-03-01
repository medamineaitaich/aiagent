# OpenAI Thread Relay (A <-> B)

A Node.js project that relays messages between two OpenAI API threads:

- `Thread A`: ChatGPT side
- `Thread B`: Codex side

Loop flow:
1. Read the latest `user` message from `Thread A`.
2. If it is new (different from `LAST_SEEN_ID`), send it to `Thread B`.
3. Run a model on `Thread B` with coding-focused instructions.
4. Send `Thread B` reply back to `Thread A`.
5. Update `state.json`.

## Files

- `index.js`: all relay logic
- `create-assistant.js`: creates a reusable Assistant and stores its ID
- `package.json`: dependencies and scripts
- `.env.example`: environment variables template
- `state.json`: auto-created state storage with:
  - `THREAD_A_ID`
  - `THREAD_B_ID`
  - `CODEX_ASSISTANT_ID`
  - `LAST_SEEN_ID`

## Requirements

- Node.js 18+
- OpenAI API key

## Run

1. Install dependencies:

```bash
npm i
```

2. Create `.env` from example:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Add your key in `.env`:

```env
OPENAI_API_KEY=...
CHATGPT_SIDE_MODEL=gpt-5.2
CODEX_SIDE_MODEL=gpt-5.2
```

4. Create the Codex assistant (required once, or when you want a new one):

```bash
node create-assistant.js
```

This prints:

```text
ASSISTANT_ID = asst_...
```

and automatically stores it as `CODEX_ASSISTANT_ID` in `state.json`.

5. Send first message to Thread A via CLI:

```bash
node index.js --send "Write a JavaScript function that reverses an array"
```

6. Start relay loop:

```bash
node index.js
```

Defaults:
- `maxTurns=10`
- `sleepMs=2000`

Custom values:

```bash
node index.js --max-turns 10 --sleep-ms 1500
```

## Notes

- On first run, the script creates both threads automatically and stores IDs in `state.json`.
- The relay uses `CODEX_ASSISTANT_ID` from `state.json` for `runs.createAndPoll(..., { assistant_id })`.
- If `CODEX_ASSISTANT_ID` is missing, run `node create-assistant.js`.
- If there is no new user message in Thread A, the loop sleeps and checks again.
- Some API configurations may reject direct `assistant` writes to a thread. The code includes a fallback that writes as `user` with a `[Codex reply]` prefix.

## Quick Commands

- Send only:

```bash
node index.js --send "hello"
```

- Run relay only:

```bash
node index.js
```

- Create/update assistant ID:

```bash
node create-assistant.js
```

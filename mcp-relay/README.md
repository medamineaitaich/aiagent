# mcp-relay

Node.js MCP server (stdio) that lets OpenAI Agent Builder call tools against your existing relay `Thread A`.

## Tools

- `send_to_thread_a`
  - Input: `{ "text": "..." }`
  - Action: sends a `user` message into `THREAD_A_ID` from relay `state.json`
  - Output: confirmation text with message id

- `get_latest_from_thread_a`
  - Input: `{}`
  - Action: returns latest `assistant` message text from Thread A, or latest message if no assistant message exists
  - Output: plain text

## Prerequisites

- Node.js 18+
- Existing relay project with `state.json` containing `THREAD_A_ID`

Default relay state path:

`D:/HDD/Downloads/anfastyle/anfastyles.shop/thread/state.json`

## Setup

1. Install dependencies:

```bash
npm i
```

2. Create `.env`:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Fill `.env`:

```env
OPENAI_API_KEY=...
RELAY_STATE_PATH=D:/HDD/Downloads/anfastyle/anfastyles.shop/thread/state.json
```

## Run

```bash
node server.js
```

On success, server logs to stderr:

`mcp-relay started on stdio...`

## Agent Builder MCP Node Configuration (Local stdio)

In OpenAI Agent Builder:

1. Add an `MCP` node / connector.
2. Choose local stdio process mode.
3. Set command to `node`.
4. Set args to `server.js`.
5. Set working directory to this project folder: `.../thread/mcp-relay`.
6. Add environment variables:
   - `OPENAI_API_KEY`
   - `RELAY_STATE_PATH` (optional if using default)
7. Save and test tool calls:
   - `send_to_thread_a` with `{ "text": "hello from agent" }`
   - `get_latest_from_thread_a` with `{}`

## Error Handling

- If `OPENAI_API_KEY` is missing: process exits with clear message.
- If `state.json` is missing or invalid: tool returns clear error text.
- If `THREAD_A_ID` is missing in state: tool returns clear error text.
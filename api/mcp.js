import OpenAI from "openai";
import crypto from "node:crypto";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const THREAD_A_ID = process.env.THREAD_A_ID;
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;

const SERVER_INFO = {
  name: "aiagent-mcp-relay",
  version: "1.0.0"
};

const PROTOCOL_VERSION = "2024-11-05";
const sseSessions = new Map();

let cachedClient = null;
function getClient() {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY environment variable.");
  }
  if (!cachedClient) {
    cachedClient = new OpenAI({ apiKey: OPENAI_API_KEY });
  }
  return cachedClient;
}

function requireAuth(req, res) {
  if (!MCP_ACCESS_TOKEN) {
    res.status(500).json({ error: "Server is missing MCP_ACCESS_TOKEN env var." });
    return false;
  }

  const auth = req.headers.authorization || "";
  const expected = `Bearer ${MCP_ACCESS_TOKEN}`;
  if (auth !== expected) {
    res.status(401).json({ error: "Unauthorized. Missing or invalid bearer token." });
    return false;
  }
  return true;
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data ? { data } : {})
    }
  };
}

function rpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result
  };
}

function getTools() {
  return [
    {
      name: "send_to_thread_a",
      title: "Send To Thread A",
      description: "Create a user message in OpenAI Thread A.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            minLength: 1,
            description: "Text to send as a user message."
          }
        },
        required: ["text"],
        additionalProperties: false
      }
    },
    {
      name: "get_latest_from_thread_a",
      title: "Get Latest From Thread A",
      description:
        "Return latest assistant message text from Thread A; fallback to the latest message if needed.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  ];
}

function messageToText(message) {
  if (!message || !Array.isArray(message.content)) {
    return "";
  }
  const chunks = [];
  for (const part of message.content) {
    if (part?.type === "text" && part?.text?.value) {
      chunks.push(part.text.value);
    }
  }
  return chunks.join("\n").trim();
}

async function sendToThreadA(text) {
  if (!THREAD_A_ID) {
    throw new Error("Missing THREAD_A_ID environment variable.");
  }
  if (!text || !String(text).trim()) {
    throw new Error("`text` must be a non-empty string.");
  }

  const client = getClient();
  const created = await client.beta.threads.messages.create(THREAD_A_ID, {
    role: "user",
    content: String(text)
  });

  return `Sent to Thread A (${THREAD_A_ID}). message_id=${created.id}`;
}

async function getLatestFromThreadA() {
  if (!THREAD_A_ID) {
    throw new Error("Missing THREAD_A_ID environment variable.");
  }

  const client = getClient();
  const list = await client.beta.threads.messages.list(THREAD_A_ID, {
    order: "desc",
    limit: 50
  });

  if (!list.data.length) {
    return "No messages found in Thread A.";
  }

  const latestAssistant = list.data.find((m) => m.role === "assistant");
  const picked = latestAssistant || list.data[0];
  const text = messageToText(picked);

  if (!text) {
    return `Latest message has no text content. role=${picked.role}, message_id=${picked.id}`;
  }

  return text;
}

async function handleRpc(payload) {
  if (!payload || typeof payload !== "object") {
    return rpcError(null, -32600, "Invalid Request");
  }

  const { id, method, params } = payload;
  if (!method || typeof method !== "string") {
    return rpcError(id, -32600, "Invalid Request: method is required");
  }

  try {
    if (method === "initialize") {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: SERVER_INFO
      });
    }

    if (method === "notifications/initialized") {
      return id === undefined ? null : rpcResult(id, {});
    }

    if (method === "ping") {
      return rpcResult(id, {});
    }

    if (method === "tools/list") {
      return rpcResult(id, {
        tools: getTools()
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      if (toolName === "send_to_thread_a") {
        const output = await sendToThreadA(args.text);
        return rpcResult(id, {
          content: [{ type: "text", text: output }]
        });
      }

      if (toolName === "get_latest_from_thread_a") {
        const output = await getLatestFromThreadA();
        return rpcResult(id, {
          content: [{ type: "text", text: output }]
        });
      }

      return rpcError(id, -32602, `Unknown tool: ${toolName}`);
    }

    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    return rpcError(id, -32000, error?.message || "Internal server error");
  }
}

function startSse(req, res) {
  const sessionId = crypto.randomUUID();
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  sseSessions.set(sessionId, { res, heartbeat });

  req.on("close", () => {
    clearInterval(heartbeat);
    sseSessions.delete(sessionId);
  });
}

function sendSseMessage(sessionId, message) {
  const session = sseSessions.get(sessionId);
  if (!session) {
    return false;
  }
  session.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  return true;
}

async function parseBody(req) {
  if (typeof req.body === "object" && req.body !== null) {
    return req.body;
  }
  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }
  return {};
}

export default async function handler(req, res) {
  if (!requireAuth(req, res)) {
    return;
  }

  if (req.method === "GET") {
    const accept = String(req.headers.accept || "");
    if (!accept.includes("text/event-stream")) {
      res
        .status(406)
        .json({ error: "GET /mcp requires Accept: text/event-stream" });
      return;
    }
    startSse(req, res);
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch {
    res.status(400).json(rpcError(null, -32700, "Parse error"));
    return;
  }

  const rpcResponse = await handleRpc(payload);
  if (!rpcResponse) {
    res.status(204).end();
    return;
  }

  const sessionId = req.headers["mcp-session-id"];
  if (typeof sessionId === "string" && sendSseMessage(sessionId, rpcResponse)) {
    res.status(202).json({ ok: true, deliveredToSse: true });
    return;
  }

  const accept = String(req.headers.accept || "");
  if (accept.includes("text/event-stream")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    res.write(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`);
    res.end();
    return;
  }

  res.status(200).json(rpcResponse);
}


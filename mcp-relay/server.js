import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import OpenAI from "openai";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const DEFAULT_RELAY_STATE_PATH =
  "D:/HDD/Downloads/anfastyle/anfastyles.shop/thread/state.json";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY. Add it to .env first.");
  process.exit(1);
}

const RELAY_STATE_PATH = path.resolve(
  process.env.RELAY_STATE_PATH || DEFAULT_RELAY_STATE_PATH
);

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

function textPart(text) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

function errorPart(message) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Error: ${message}`
      }
    ]
  };
}

async function loadRelayState() {
  let raw;

  try {
    raw = await fs.readFile(RELAY_STATE_PATH, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Relay state file not found at: ${RELAY_STATE_PATH}`);
    }
    throw new Error(`Failed reading relay state: ${error?.message || String(error)}`);
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Relay state is not valid JSON: ${error?.message || String(error)}`);
  }

  if (!state || typeof state !== "object") {
    throw new Error("Relay state JSON is invalid.");
  }

  if (!state.THREAD_A_ID) {
    throw new Error(
      "THREAD_A_ID is missing in relay state. Start relay project once to create threads."
    );
  }

  return state;
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

const server = new McpServer(
  {
    name: "mcp-relay",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.registerTool(
  "send_to_thread_a",
  {
    title: "Send To Thread A",
    description: "Send a user message to Thread A from relay state.json",
    inputSchema: {
      text: z.string().min(1)
    }
  },
  async ({ text }) => {
    try {
      const state = await loadRelayState();
      const created = await client.beta.threads.messages.create(state.THREAD_A_ID, {
        role: "user",
        content: text
      });

      return textPart(
        `Sent to Thread A (${state.THREAD_A_ID}). message_id=${created.id}`
      );
    } catch (error) {
      return errorPart(error?.message || String(error));
    }
  }
);

server.registerTool(
  "get_latest_from_thread_a",
  {
    title: "Get Latest From Thread A",
    description:
      "Read latest assistant message from Thread A; fallback to latest message if no assistant exists",
    inputSchema: {}
  },
  async () => {
    try {
      const state = await loadRelayState();
      const messages = await client.beta.threads.messages.list(state.THREAD_A_ID, {
        order: "desc",
        limit: 50
      });

      if (!messages.data.length) {
        return textPart("No messages found in Thread A.");
      }

      const latestAssistant = messages.data.find((m) => m.role === "assistant");
      const latestAny = messages.data[0];
      const picked = latestAssistant || latestAny;
      const text = messageToText(picked);

      if (!text) {
        return textPart(
          `Latest message has no text content. role=${picked.role}, message_id=${picked.id}`
        );
      }

      return textPart(text);
    } catch (error) {
      return errorPart(error?.message || String(error));
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(`mcp-relay started on stdio. state=${RELAY_STATE_PATH}`);
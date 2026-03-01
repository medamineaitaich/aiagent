import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY. Add it to .env first.");
  process.exit(1);
}

const client = new OpenAI({ apiKey });
const STATE_PATH = path.resolve("state.json");

const CHATGPT_SIDE_MODEL = process.env.CHATGPT_SIDE_MODEL || "gpt-5.2";
const CODEX_SIDE_MODEL = process.env.CODEX_SIDE_MODEL || "gpt-5.2";
const DEFAULT_STATE = {
  THREAD_A_ID: null,
  THREAD_B_ID: null,
  CODEX_ASSISTANT_ID: null,
  LAST_SEEN_ID: null
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCli(argv) {
  const args = [...argv];
  const sendIndex = args.indexOf("--send");
  const maxTurnsIndex = args.indexOf("--max-turns");
  const sleepMsIndex = args.indexOf("--sleep-ms");

  const sendText =
    sendIndex >= 0 && args[sendIndex + 1] ? String(args[sendIndex + 1]) : null;

  const maxTurns =
    maxTurnsIndex >= 0 && args[maxTurnsIndex + 1]
      ? Number(args[maxTurnsIndex + 1])
      : 10;

  const sleepMs =
    sleepMsIndex >= 0 && args[sleepMsIndex + 1]
      ? Number(args[sleepMsIndex + 1])
      : 2000;

  if (!Number.isFinite(maxTurns) || maxTurns <= 0) {
    throw new Error("--max-turns must be a positive number.");
  }
  if (!Number.isFinite(sleepMs) || sleepMs < 0) {
    throw new Error("--sleep-ms must be a number >= 0.");
  }

  return { sendText, maxTurns, sleepMs };
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ...DEFAULT_STATE };
    }
    throw error;
  }
}

async function saveState(state) {
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  await fs.writeFile(STATE_PATH, payload, "utf8");
}

async function createThreads() {
  const state = await loadState();
  let changed = false;

  if (!state.THREAD_A_ID) {
    const threadA = await client.beta.threads.create();
    state.THREAD_A_ID = threadA.id;
    changed = true;
  }

  if (!state.THREAD_B_ID) {
    const threadB = await client.beta.threads.create();
    state.THREAD_B_ID = threadB.id;
    changed = true;
  }

  if (typeof state.CODEX_ASSISTANT_ID === "undefined") {
    state.CODEX_ASSISTANT_ID = null;
    changed = true;
  }

  if (changed) {
    await saveState(state);
  }

  return state;
}

async function sendMessage(threadId, text, role = "user") {
  if (!text || !String(text).trim()) {
    throw new Error("Message text cannot be empty.");
  }

  return client.beta.threads.messages.create(threadId, {
    role,
    content: String(text)
  });
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

async function runAssistantOnThread(threadId, assistantId) {
  if (!assistantId) {
    throw new Error("Missing CODEX_ASSISTANT_ID. Run `node create-assistant.js` first.");
  }

  const run = await client.beta.threads.runs.createAndPoll(threadId, {
    assistant_id: assistantId
  });

  if (run.status !== "completed") {
    throw new Error(`Run not completed. Status: ${run.status}`);
  }

  const messages = await client.beta.threads.messages.list(threadId, {
    order: "desc",
    limit: 20
  });

  const assistantMessage =
    messages.data.find((msg) => msg.role === "assistant" && msg.run_id === run.id) ||
    messages.data.find((msg) => msg.role === "assistant");

  if (!assistantMessage) {
    throw new Error("No assistant output message found on Thread B.");
  }

  const text = messageToText(assistantMessage);
  if (!text) {
    throw new Error("Assistant output was empty.");
  }

  return text;
}

async function getLatestUserMessage(threadId) {
  const messages = await client.beta.threads.messages.list(threadId, {
    order: "desc",
    limit: 50
  });

  return messages.data.find((msg) => msg.role === "user") || null;
}

async function relayLoop({ maxTurns = 10, sleepMs = 2000 } = {}) {
  const state = await createThreads();
  if (!state.CODEX_ASSISTANT_ID) {
    throw new Error("Missing CODEX_ASSISTANT_ID in state.json. Run `node create-assistant.js` first.");
  }

  console.log(`Thread A (ChatGPT side): ${state.THREAD_A_ID}`);
  console.log(`Thread B (Codex side): ${state.THREAD_B_ID}`);
  console.log(`Models => ChatGPT side: ${CHATGPT_SIDE_MODEL}, Codex side: ${CODEX_SIDE_MODEL}`);
  console.log(`Codex Assistant ID: ${state.CODEX_ASSISTANT_ID}`);
  console.log(`Starting relay loop for maxTurns=${maxTurns}, sleepMs=${sleepMs}...`);

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const current = await loadState();
    const latestUserMessage = await getLatestUserMessage(current.THREAD_A_ID);

    if (!latestUserMessage) {
      console.log(`[turn ${turn}] No user message found in Thread A.`);
      await sleep(sleepMs);
      continue;
    }

    if (latestUserMessage.id === current.LAST_SEEN_ID) {
      console.log(`[turn ${turn}] No new user message in Thread A.`);
      await sleep(sleepMs);
      continue;
    }

    const userText = messageToText(latestUserMessage);
    if (!userText) {
      console.log(`[turn ${turn}] New user message is empty, skipping.`);
      current.LAST_SEEN_ID = latestUserMessage.id;
      await saveState(current);
      await sleep(sleepMs);
      continue;
    }

    console.log(`[turn ${turn}] New message detected in Thread A: ${latestUserMessage.id}`);

    await sendMessage(current.THREAD_B_ID, userText, "user");
    const codexReply = await runAssistantOnThread(current.THREAD_B_ID, current.CODEX_ASSISTANT_ID);

    try {
      await sendMessage(current.THREAD_A_ID, codexReply, "assistant");
    } catch (error) {
      console.warn(
        `[turn ${turn}] Could not write assistant role in Thread A, fallback to user role. Reason: ${error.message}`
      );
      await sendMessage(current.THREAD_A_ID, `[Codex reply]\n${codexReply}`, "user");
    }

    current.LAST_SEEN_ID = latestUserMessage.id;
    current.LAST_RELAY_AT = new Date().toISOString();
    await saveState(current);

    console.log(`[turn ${turn}] Relayed user->ThreadB->ThreadA successfully.`);
    await sleep(sleepMs);
  }

  console.log("Relay loop finished (safety maxTurns reached).");
}

async function main() {
  const { sendText, maxTurns, sleepMs } = parseCli(process.argv.slice(2));
  const state = await createThreads();

  if (sendText) {
    const sent = await sendMessage(state.THREAD_A_ID, sendText, "user");
    console.log(`Sent to Thread A (${state.THREAD_A_ID}): ${sent.id}`);
    return;
  }

  await relayLoop({ maxTurns, sleepMs });
}

main().catch((error) => {
  console.error("Fatal error:", error?.message || error);
  process.exit(1);
});

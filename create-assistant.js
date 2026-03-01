import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import OpenAI from "openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Missing OPENAI_API_KEY. Add it to .env first.");
  process.exit(1);
}

const client = new OpenAI({ apiKey });
const STATE_PATH = path.resolve("state.json");
const DEFAULT_STATE = {
  THREAD_A_ID: null,
  THREAD_B_ID: null,
  CODEX_ASSISTANT_ID: null,
  LAST_SEEN_ID: null
};

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

async function main() {
  const assistant = await client.beta.assistants.create({
    name: "Codex Relay Assistant",
    model: process.env.CODEX_SIDE_MODEL || "gpt-5.2",
    instructions:
      "You are a coding assistant. Answer with clear code and practical technical steps."
  });

  const state = await loadState();
  state.CODEX_ASSISTANT_ID = assistant.id;
  await saveState(state);

  console.log(`ASSISTANT_ID = ${assistant.id}`);
  console.log(`Saved CODEX_ASSISTANT_ID in ${STATE_PATH}`);
}

main().catch((error) => {
  console.error("Failed to create assistant:", error?.message || error);
  process.exit(1);
});

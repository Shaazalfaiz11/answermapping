import Groq from "groq-sdk";
import { readFileSync } from "fs";

const g = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Probe probe_800.jpg vs probe_1100.jpg or generate scale
const img1100 = "data:image/jpeg;base64," + readFileSync("fixtures/probe_1100.jpg").toString("base64");
const img800 = "data:image/jpeg;base64," + readFileSync("fixtures/probe_800.jpg").toString("base64");
const img500 = "data:image/jpeg;base64," + readFileSync("fixtures/probe_500.jpg").toString("base64");

for (const [label, img] of [["1100px", img1100], ["800px", img800], ["500px", img500]]) {
  console.time(label);
  try {
    const res = await g.chat.completions.create({
      model: "qwen/qwen3.8-27b",
      temperature: 0,
      max_completion_tokens: 100,
      messages: [
        { role: "user", content: [{ type: "text", text: "Read handwriting" }, { type: "image_url", image_url: { url: img } }] },
      ],
    });
    console.timeEnd(label);
    console.log(label, "Prompt Tokens:", res.usage?.prompt_tokens, "Total Tokens:", res.usage?.total_tokens);
  } catch (e) {
    console.timeEnd(label);
    console.error(label, "Error:", e.message);
  }
}

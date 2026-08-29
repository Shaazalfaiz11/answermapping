import Groq from "groq-sdk";
import { readFileSync } from "fs";

const g = new Groq({ apiKey: process.env.GROQ_API_KEY });
const img = "data:image/png;base64," + readFileSync("fixtures/question_paper_p1.png").toString("base64");

for (const model of ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"]) {
  console.log("\nTesting model:", model);
  console.time(model);
  try {
    const res = await g.chat.completions.create({
      model,
      temperature: 0,
      max_completion_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You extract questions from exam paper into json." },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract questions in printed order as json." },
            { type: "image_url", image_url: { url: img } },
          ],
        },
      ],
    });
    console.timeEnd(model);
    console.log(model, "Usage:", res.usage);
    console.log(model, "Choices:", res.choices[0]?.message?.content?.slice(0, 200));
  } catch (e) {
    console.timeEnd(model);
    console.error(model, "Error:", e.message);
  }
}

import Groq from "groq-sdk";

const g = new Groq({ apiKey: process.env.GROQ_API_KEY });

for (const m of ["qwen/qwen3.6-27b", "qwen/qwen3.8-27b"]) {
  console.time(m);
  try {
    const res = await g.chat.completions.create({
      model: m,
      max_completion_tokens: 100,
      response_format: { type: "json_object" },
      reasoning_effort: m.includes("3.6") ? "none" : undefined,
      messages: [{ role: "user", content: 'Return a json object: {"status": "ok"}' }],
    });
    console.timeEnd(m);
    console.log(m, "->", res.choices[0]?.message?.content?.trim());
  } catch (e) {
    console.log(m, "ERROR ->", e.message);
  }
}

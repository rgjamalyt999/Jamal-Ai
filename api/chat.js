async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function detectProvider(key) {
  if (!key) return "none";
  if (key.startsWith("AQ.")) return "gemini_vertex";
  if (key.startsWith("AIza")) return "gemini_dev";
  if (key.startsWith("gsk_")) return "groq";
  if (key.startsWith("sk-or-")) return "openrouter";
  return "gemini_vertex";
}

function buildGeminiPayload(messages, temperature) {
  let systemText = "";
  const contents = [];

  for (const m of messages) {
    if (!m || !m.role) continue;
    if (m.role === "system") {
      if (typeof m.content === "string" && m.content.trim()) {
        systemText += (systemText ? "\n" : "") + m.content.trim();
      }
      continue;
    }

    const role = m.role === "assistant" ? "model" : "user";
    const parts = [];

    if (typeof m.content === "string" && m.content.trim()) {
      parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const item of m.content) {
        if (item.type === "text" && item.text) {
          parts.push({ text: item.text });
        } else if (item.type === "image_url" && item.image_url && item.image_url.url) {
          const match = item.image_url.url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
          if (match) {
            parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
          }
        }
      }
    }

    if (!parts.length) continue;
    if (!contents.length && role === "model") continue;

    if (contents.length && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }

  if (!contents.length) {
    contents.push({ role: "user", parts: [{ text: "Hello" }] });
  }

  const payload = {
    contents,
    generationConfig: { temperature }
  };
  if (systemText) {
    payload.systemInstruction = { parts: [{ text: systemText }] };
  }
  return payload;
}

async function callGemini(apiKey, provider, messages, temperature) {
  const payload = buildGeminiPayload(messages, temperature);
  const models = ["gemini-2.5-flash", "gemini-2.0-flash"];
  const attempts = [];

  for (const model of models) {
    if (provider === "gemini_vertex") {
      attempts.push({
        label: `vertex-v1/${model}`,
        url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        headers: { "Content-Type": "application/json" }
      });
      attempts.push({
        label: `ai-studio/${model}`,
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        headers: { "Content-Type": "application/json" }
      });
    } else {
      attempts.push({
        label: `ai-studio/${model}`,
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        headers: { "Content-Type": "application/json" }
      });
      attempts.push({
        label: `vertex-v1/${model}`,
        url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  const errors = [];

  for (const ep of attempts) {
    try {
      const r = await fetch(ep.url, {
        method: "POST",
        headers: ep.headers,
        body: JSON.stringify(payload)
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) {
        const text = (data.candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || "")
          .join("")
          .trim();
        return { ok: true, model: ep.label, content: text || "Response empty aaya." };
      }
      errors.push(`${ep.label} (${r.status}): ${data?.error?.message || "Failed"}`);
    } catch (e) {
      errors.push(`${ep.label}: ${e.message}`);
    }
  }

  return { ok: false, error: errors[0] || "All Gemini endpoints failed", details: errors };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  const envKey = (process.env.AI_API_KEY || process.env.GEMINI_API_KEY || "").trim();
  const headerKey = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const apiKey = envKey || headerKey;
  const provider = detectProvider(apiKey);

  // Browser check: /api/chat ya live test: /api/chat?test=1
  if (req.method === "GET") {
    const runTest = req.query && req.query.test === "1";
    if (!runTest) {
      return res.status(200).json({
        status: "ONLINE",
        keyConfigured: Boolean(apiKey),
        keyPrefix: apiKey ? apiKey.slice(0, 6) + "..." : "NONE",
        provider
      });
    }
    if (!apiKey) {
      return res.status(200).json({ ok: false, error: "AI_API_KEY Vercel Environment Variables mein set nahi hai." });
    }
    if (provider === "gemini_vertex" || provider === "gemini_dev") {
      const testOut = await callGemini(apiKey, provider, [{ role: "user", content: "Reply with OK only." }], 0.2);
      return res.status(200).json(testOut);
    }
    return res.status(200).json({ ok: true, provider, note: "Key set hai" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  if (!apiKey) {
    return res.status(500).json({
      error: { message: "AI_API_KEY missing hai. Vercel Environment Variables mein AI_API_KEY add karein." }
    });
  }

  try {
    const body = await readJsonBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const mode = body.mode || "auto";
    const temperature = typeof body.temperature === "number" ? body.temperature : 0.6;

    // 1. GOOGLE GEMINI (AQ. & AIza keys)
    if (provider === "gemini_vertex" || provider === "gemini_dev") {
      const result = await callGemini(apiKey, provider, messages, temperature);
      if (result.ok) {
        return res.status(200).json({
          choices: [{ message: { role: "assistant", content: result.content } }],
          model: result.model
        });
      }
      return res.status(502).json({ error: { message: result.error, details: result.details } });
    }

    // 2. GROQ / OPENROUTER
    const hasImage = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")
    );
    const endpoint =
      provider === "groq"
        ? "https://api.groq.com/openai/v1/chat/completions"
        : "https://openrouter.ai/api/v1/chat/completions";
    const model =
      provider === "groq"
        ? (hasImage ? "meta-llama/llama-4-scout-17b-16e-instruct" : (mode === "fast" ? "llama-3.1-8b-instant" : "llama-3.3-70b-versatile"))
        : "openrouter/auto";

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };
    if (provider === "openrouter") {
      headers["HTTP-Referer"] = "https://vercel.app";
      headers["X-Title"] = "Jamal AI";
    }

    const upRes = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, temperature, stream: false })
    });
    const upData = await upRes.json().catch(() => ({}));
    return res.status(upRes.status).json(upData);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message || "Internal server error" } });
  }
};

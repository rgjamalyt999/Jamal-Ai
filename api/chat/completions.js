module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();

  const envKey = (process.env.AI_API_KEY || "").trim();
  const headerKey = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const apiKey = envKey || headerKey;

  const detectProvider = (key) => {
    if (!key) return "none";
    if (key.startsWith("AIza")) return "gemini";
    if (key.startsWith("gsk_")) return "groq";
    if (key.startsWith("sk-or-")) return "openrouter";
    if (process.env.CUSTOM_API_URL) return "custom";
    return "unknown";
  };

  if (req.method === "GET") {
    return res.status(200).json({
      status: "ONLINE",
      keyConfigured: Boolean(apiKey),
      provider: detectProvider(apiKey)
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: { message: "Method not allowed" } });
  }

  if (!apiKey) {
    return res.status(500).json({
      error: { message: "AI_API_KEY Vercel Environment Variables mein set nahi hai." }
    });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const mode = body.mode || "auto";
    const temperature = typeof body.temperature === "number" ? body.temperature : 0.6;
    const provider = detectProvider(apiKey);

    // 1. GOOGLE GEMINI (Native API - Full Text + Photo Vision Support)
    if (provider === "gemini") {
      let systemText = "";
      const contents = [];

      for (const m of messages) {
        if (m.role === "system") {
          systemText += (systemText ? "\n" : "") + (typeof m.content === "string" ? m.content : "");
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
                parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
              }
            }
          }
        }

        if (!parts.length) continue;
        if (contents.length && contents[contents.length - 1].role === role) {
          contents[contents.length - 1].parts.push(...parts);
        } else {
          contents.push({ role, parts });
        }
      }

      const payload = {
        contents,
        generationConfig: { temperature }
      };
      if (systemText) {
        payload.systemInstruction = { parts: [{ text: systemText }] };
      }

      const geminiModels = ["gemini-2.5-flash", "gemini-2.0-flash"];
      let lastError = "Gemini API error";

      for (const modelName of geminiModels) {
        const gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }
        );
        const gData = await gRes.json().catch(() => ({}));
        if (gRes.ok) {
          const text = (gData.candidates?.[0]?.content?.parts || [])
            .map((p) => p.text || "")
            .join("")
            .trim();
          return res.status(200).json({
            choices: [{ message: { role: "assistant", content: text || "Response empty aaya." } }]
          });
        }
        lastError = gData?.error?.message || `HTTP ${gRes.status}`;
      }

      return res.status(502).json({ error: { message: lastError } });
    }

    // 2. GROQ / OPENROUTER / CUSTOM OPENAI-COMPATIBLE
    const hasImage = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")
    );

    let endpoint = "";
    let model = process.env.CUSTOM_MODEL || "auto";
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };

    if (provider === "groq") {
      endpoint = "https://api.groq.com/openai/v1/chat/completions";
      model = hasImage
        ? "meta-llama/llama-4-scout-17b-16e-instruct"
        : (mode === "fast" ? "llama-3.1-8b-instant" : "llama-3.3-70b-versatile");
    } else if (provider === "openrouter") {
      endpoint = "https://openrouter.ai/api/v1/chat/completions";
      model = "openrouter/auto";
      headers["HTTP-Referer"] = "https://jamal-ai-indol.vercel.app";
      headers["X-Title"] = "Jamal AI";
    } else if (process.env.CUSTOM_API_URL) {
      endpoint = `${process.env.CUSTOM_API_URL.replace(/\/+$/, "")}/chat/completions`;
    } else {
      return res.status(400).json({
        error: { message: "Key format valid nahi hai. Gemini (AIza...), Groq (gsk_...), ya OpenRouter (sk-or-...) key daalein." }
      });
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

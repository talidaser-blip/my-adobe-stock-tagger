const apiKeyInput = document.getElementById("apiKey");
const statusDiv = document.getElementById("status");

chrome.storage.local.get(["groqKey"], (res) => {
  if (res.groqKey) apiKeyInput.value = res.groqKey;
});

document.getElementById("runBtn").addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    statusDiv.textContent = "Ошибка: вставьте ключ Groq!";
    return;
  }
  chrome.storage.local.set({ groqKey: apiKey });
  statusDiv.textContent = "Анализирую фото (2-3 сек)...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (key) => {
      const img = document.querySelector('img[src*="ftcdn.net"], img[src*="adobe.com"]');
      if (!img) return "Не найдено превью фото на странице.";

      const canvas = document.createElement("canvas");
      canvas.width = 512;
      canvas.height = Math.round((img.naturalHeight / img.naturalWidth) * 512) || 512;
      const ctx = canvas.getContext("2d");
      img.crossOrigin = "anonymous";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const base64Image = canvas.toDataURL("image/jpeg", 0.8);

      const prompt = `Analyze this image for Adobe Stock. Return ONLY valid JSON with keys "title" and "keywords".
      Rules:
      1. "title": Commercial English title (100-180 chars), no brand names.
      2. "keywords": Array of EXACTLY 48 single English words (NO two-word phrases!), ordered by descending relevance, including conceptual words.`;

      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "meta-llama/llama-4-scout-17b-16e-instruct",
          messages: [{
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: base64Image } }
            ]
          }],
          response_format: { type: "json_object" },
          temperature: 0.3
        })
      });

      const data = await response.json();
      if (!response.ok) return "Ошибка Groq: " + (data.error?.message || response.status);

      const result = JSON.parse(data.choices[0].message.content);
      const cleanKeywords = [...new Set(result.keywords.map(w => w.trim().toLowerCase().split(/\s+/)[0]))].slice(0, 48).join(", ");

      const titleInput = document.querySelector('textarea[name="title"], input[name="title"], textarea[aria-label*="title" i]');
      const kwInput = document.querySelector('textarea[name="keywords"], textarea[aria-label*="keyword" i]');

      if (titleInput) {
        titleInput.value = result.title;
        titleInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (kwInput) {
        kwInput.value = cleanKeywords;
        kwInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return "Готово! Вставлено слов: " + cleanKeywords.split(", ").length;
    },
    args: [apiKey]
  }, (results) => {
    statusDiv.textContent = results?.[0]?.result || "Готово!";
  });
});

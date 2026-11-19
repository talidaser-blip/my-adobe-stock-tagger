const apiKeyInput = document.getElementById("apiKey");
const aiCheckInput = document.getElementById("aiCheck");
const runBtn = document.getElementById("runBtn");
const statusDiv = document.getElementById("status");

chrome.storage.local.get(["groqKey", "markAi"], (res) => {
  if (res.groqKey) apiKeyInput.value = res.groqKey;
  if (typeof res.markAi === "boolean") aiCheckInput.checked = res.markAi;
});

runBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  const markAi = aiCheckInput.checked;

  if (!apiKey) {
    statusDiv.textContent = "Ошибка: вставьте API-ключ Groq (начинается на gsk_)!";
    return;
  }

  chrome.storage.local.set({ groqKey: apiKey, markAi });
  runBtn.disabled = true;
  statusDiv.textContent = "Запускаю обработку на странице Adobe Stock...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes("contributor.stock.adobe.com")) {
    statusDiv.textContent = "Ошибка: откройте вкладку с загруженными файлами Adobe Stock!";
    runBtn.disabled = false;
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (key, shouldMarkAi) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      const allCards = Array.from(document.querySelectorAll('[data-testid="asset-card"], .upload-tile, [class*="asset-card"], [class*="upload-item"]'))
        .filter((el) => el.querySelector('img'));

      const selectedCards = allCards.filter((card) =>
        card.getAttribute("aria-selected") === "true" ||
        card.className.toLowerCase().includes("selected") ||
        card.querySelector('input[type="checkbox"]:checked')
      );

      const targetCards = selectedCards.length > 0 ? selectedCards : allCards;

      if (targetCards.length === 0) {
        return "Не найдены карточки фотографий на странице. Убедитесь, что открыта вкладка Uploaded Files.";
      }

      const getImageBase64 = (imgEl) => {
        return new Promise((resolve) => {
          const tempImg = new Image();
          tempImg.crossOrigin = "anonymous";
          tempImg.onload = () => {
            const canvas = document.createElement("canvas");
            const scale = 512 / Math.max(tempImg.naturalWidth, tempImg.naturalHeight, 1);
            canvas.width = Math.round(tempImg.naturalWidth * scale) || 512;
            canvas.height = Math.round(tempImg.naturalHeight * scale) || 512;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(tempImg, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", 0.82));
          };
          tempImg.onerror = () => {
            const canvas = document.createElement("canvas");
            canvas.width = 512;
            canvas.height = 512;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(imgEl, 0, 0, 512, 512);
            resolve(canvas.toDataURL("image/jpeg", 0.82));
          };
          tempImg.src = imgEl.src;
        });
      };

      const setNativeValue = (element, value) => {
        const valueSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
        const prototype = Object.getPrototypeOf(element);
        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
          prototypeValueSetter.call(element, value);
        } else if (valueSetter) {
          valueSetter.call(element, value);
        } else {
          element.value = value;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };

      // Автоматически находим рабочую Vision-модель на вашем аккаунте Groq
      let activeModel = null;
      const modelsRes = await fetch("https://api.groq.com/openai/v1/models", {
        headers: { "Authorization": `Bearer ${key}` }
      });
      if (modelsRes.ok) {
        const modelsData = await modelsRes.json();
        const availableIds = (modelsData.data || []).map((m) => m.id);
        const preferred = [
          "meta-llama/llama-4-maverick-17b-128e-instruct",
          "llama-3.2-11b-vision-preview",
          "llama-3.2-90b-vision-preview",
          "meta-llama/llama-4-scout-17b-16e-instruct"
        ];
        activeModel = preferred.find((id) => availableIds.includes(id)) ||
                      availableIds.find((id) => id.includes("vision") || id.includes("llama-4"));
      }
      if (!activeModel) {
        activeModel = "llama-3.2-11b-vision-preview";
      }

      let processedCount = 0;

      for (let i = 0; i < targetCards.length; i++) {
        const card = targetCards[i];
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.click();
        await sleep(700);

        const img = card.querySelector("img");
        if (!img) continue;

        const base64Image = await getImageBase64(img);

        const prompt = `Analyze this image for Adobe Stock microstock. Return ONLY a valid JSON object with keys "title" and "keywords".
Strict rules:
1. "title": Commercial descriptive English title between 100 and 180 characters. No brand names or trademarks.
2. "keywords": Array of EXACTLY 48 single English words (strictly 1 word per item, NO two-word phrases, NO hyphens). Ordered by descending relevance (most important visual subjects first, conceptual words after).`;

        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: activeModel,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: prompt },
                  { type: "image_url", image_url: { url: base64Image } }
                ]
              }
            ],
            response_format: { type: "json_object" },
            temperature: 0.25
          })
        });

        const data = await response.json();
        if (!response.ok) {
          return `Остановлено на фото ${i + 1} (${activeModel}). Ошибка Groq: ${data.error?.message || response.status}`;
        }

        const parsed = JSON.parse(data.choices[0].message.content);

        const singleWords = [];
        for (const rawWord of parsed.keywords || []) {
          const clean = String(rawWord).trim().toLowerCase().replace(/[^a-z]/g, "");
          if (clean && clean.length > 1 && !singleWords.includes(clean)) {
            singleWords.push(clean);
          }
        }
        const finalKeywords = singleWords.slice(0, 48).join(", ");

        const titleInput = document.querySelector('textarea[name="title"], input[name="title"], textarea[aria-label*="title" i], textarea[placeholder*="title" i]');
        if (titleInput && parsed.title) {
          setNativeValue(titleInput, parsed.title.trim().slice(0, 195));
        }

        const kwInput = document.querySelector('textarea[name="keywords"], textarea[aria-label*="keyword" i], textarea[placeholder*="keyword" i]');
        if (kwInput && finalKeywords) {
          setNativeValue(kwInput, finalKeywords);
        }

        if (shouldMarkAi) {
          const labels = Array.from(document.querySelectorAll("label, span, div"));
          const aiLabel = labels.find((el) => el.textContent && el.textContent.toLowerCase().includes("generative ai"));
          if (aiLabel) {
            const container = aiLabel.closest("label") || aiLabel.parentElement;
            const checkbox = container?.querySelector('input[type="checkbox"]') || document.querySelector('input[type="checkbox"][name*="generative" i], input[type="checkbox"][id*="generative" i]');
            if (checkbox && !checkbox.checked) {
              checkbox.click();
            }
          }
        }

        processedCount++;
        if (i < targetCards.length - 1) {
          await sleep(2500);
        }
      }

      return `Готово! Успешно заполнено: ${processedCount} из ${targetCards.length} (модель: ${activeModel}).`;
    },
    args: [apiKey, markAi]
  }, (results) => {
    runBtn.disabled = false;
    if (chrome.runtime.lastError) {
      statusDiv.textContent = "Ошибка скрипта: " + chrome.runtime.lastError.message;
    } else {
      statusDiv.textContent = results?.[0]?.result || "Обработка завершена!";
    }
  });
});

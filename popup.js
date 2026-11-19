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
  statusDiv.textContent = "Запускаю обработку по вашей инструкции...";

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

      // Миниатюра 256px (расходует в 3 раза меньше токенов Groq, оригинальное фото на Adobe не трогает)
      const getImageBase64 = (imgEl) => {
        return new Promise((resolve) => {
          const tempImg = new Image();
          tempImg.crossOrigin = "anonymous";
          tempImg.onload = () => {
            const canvas = document.createElement("canvas");
            const scale = 256 / Math.max(tempImg.naturalWidth, tempImg.naturalHeight, 1);
            canvas.width = Math.round(tempImg.naturalWidth * scale) || 256;
            canvas.height = Math.round(tempImg.naturalHeight * scale) || 256;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(tempImg, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", 0.7));
          };
          tempImg.onerror = () => {
            const canvas = document.createElement("canvas");
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(imgEl, 0, 0, 256, 256);
            resolve(canvas.toDataURL("image/jpeg", 0.7));
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

      const CATEGORY_NAMES = {
        2: ["building", "architecture", "здания", "архитектура", "интерьер"],
        5: ["landscape", "nature", "пейзаж", "природа"],
        6: ["feeling", "emotion", "чувств", "эмоц"],
        7: ["food", "еда", "напит"],
        12: ["lifestyle", "образ жизни", "стиль жизни"]
      };

      const BANNED_WORDS = new Set([
        "overlayeffect", "visual", "designconcept", "concept", "shot", "ai",
        "generated", "artificial", "intelligence", "midjourney", "render", "rendering",
        "image", "photo", "picture", "stock", "backgroundeffect", "abstractconcept"
      ]);

      const MODEL_ID = "qwen/qwen3.8-27b";
      let processedCount = 0;

      for (let i = 0; i < targetCards.length; i++) {
        const card = targetCards[i];
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.click();
        await sleep(750);

        const img = card.querySelector("img");
        if (!img) continue;

        const base64Image = await getImageBase64(img);

        const prompt = `Adobe Stock metadata JSON {"title","keywords","category"}:
1."title": English <=190 chars, no ending period, capitalized, no brands: subject + person + setting + light + ending with concept.
2."keywords": array of 53 single lowercase English words (no phrases/hyphens/duplicates), top 10 most relevant, NO trash/AI words (overlayeffect,visual,designconcept,concept,shot,ai,generated,render).
3."category": integer: 6 or 12 for people, 2 interiors, 5 nature, 7 food, default 6.`;

        let successData = null;

        for (let attempt = 1; attempt <= 5; attempt++) {
          const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${key}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: MODEL_ID,
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
          if (response.ok) {
            successData = data;
            break;
          }

          const errMsg = data.error?.message || "";
          if (response.status === 429 || errMsg.toLowerCase().includes("rate limit")) {
            // Считываем точное время ожидания из ответа Groq (например, 15.2s) + 2 секунды запаса
            const match = errMsg.match(/try again in ([\d.]+)s/i);
            const waitMs = match ? (Math.ceil(parseFloat(match[1])) + 2) * 1000 : 18000;
            await sleep(waitMs);
          } else {
            return `Ошибка на фото ${i + 1}: ${errMsg || response.status}`;
          }
        }

        if (!successData) {
          return `Остановлено на фото ${i + 1}: сервер Groq перегружен, попробуйте ещё раз.`;
        }

        const parsed = JSON.parse(successData.choices[0].message.content);

        if (parsed.title) {
          let cleanTitle = String(parsed.title)
            .replace(/\bshot\b/gi, "photo")
            .replace(/[.!?]+$/g, "")
            .trim();
          cleanTitle = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
          cleanTitle = cleanTitle.slice(0, 198).replace(/[.!?]+$/g, "").trim();

          const titleInput = document.querySelector('textarea[name="title"], input[name="title"], textarea[aria-label*="title" i], textarea[placeholder*="title" i]');
          if (titleInput) {
            setNativeValue(titleInput, cleanTitle);
          }
        }

        const singleWords = [];
        for (const rawWord of parsed.keywords || []) {
          const clean = String(rawWord).trim().toLowerCase().replace(/[^a-z]/g, "");
          if (clean && clean.length > 1 && !BANNED_WORDS.has(clean) && !singleWords.includes(clean)) {
            singleWords.push(clean);
          }
        }
        const finalKeywords = singleWords.slice(0, 49).join(", ");

        const kwInput = document.querySelector('textarea[name="keywords"], textarea[aria-label*="keyword" i], textarea[placeholder*="keyword" i]');
        if (kwInput && finalKeywords) {
          setNativeValue(kwInput, finalKeywords);
        }

        const catCode = [2, 5, 6, 7, 12].includes(Number(parsed.category)) ? Number(parsed.category) : 6;
        const catSelect = document.querySelector('select[name*="category" i], select[aria-label*="category" i], select');
        if (catSelect) {
          const keywordsForCat = CATEGORY_NAMES[catCode] || CATEGORY_NAMES[6];
          const matchedOption = Array.from(catSelect.options).find((opt) =>
            opt.value === String(catCode) ||
            keywordsForCat.some((kw) => opt.text.toLowerCase().includes(kw))
          );
          if (matchedOption) {
            catSelect.value = matchedOption.value;
            catSelect.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }

        if (shouldMarkAi) {
          const labels = Array.from(document.querySelectorAll("label, span, div"));
          const aiLabel = labels.find((el) => el.textContent && (
            el.textContent.toLowerCase().includes("generative ai") ||
            el.textContent.toLowerCase().includes("искусственного интеллекта")
          ));
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
          await sleep(6000);
        }
      }

      return `Готово! Успешно заполнено: ${processedCount} из ${targetCards.length} фото (Title + 49 слов + категория).`;
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

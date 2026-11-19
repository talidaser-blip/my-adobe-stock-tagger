const apiKeyInput = document.getElementById("apiKey");
const aiCheckInput = document.getElementById("aiCheck");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDiv = document.getElementById("status");

chrome.storage.local.get(["openrouterKey", "markAi"], (res) => {
  if (res.openrouterKey) apiKeyInput.value = res.openrouterKey;
  if (typeof res.markAi === "boolean") aiCheckInput.checked = res.markAi;
});

stopBtn.addEventListener("click", () => {
  chrome.storage.local.set({ stopRequested: true });
  statusDiv.textContent = "Команда отмены отправлена! Останавливаю...";
});

runBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  const markAi = aiCheckInput.checked;

  if (!apiKey) {
    statusDiv.textContent = "Ошибка: вставьте API-ключ OpenRouter (начинается на sk-or-v1-)!";
    return;
  }

  await chrome.storage.local.set({ openrouterKey: apiKey, markAi, stopRequested: false });
  runBtn.disabled = true;
  statusDiv.textContent = "Быстрая обработка через OpenRouter...";

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
      const isStopped = async () => {
        const res = await chrome.storage.local.get(["stopRequested"]);
        return Boolean(res.stopRequested);
      };

      const selectAllCheckbox = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((cb) => {
        const parentText = cb.closest("label, div, span")?.textContent || "";
        return parentText.includes("Выбрать все") || parentText.includes("Select all");
      });
      if (selectAllCheckbox && selectAllCheckbox.checked) {
        return "На странице активна галочка «Выбрать все» (100 файлов). Снимите её, выделите только нужные 1–10 фото и нажмите «Запустить».";
      }

      const allImgs = Array.from(document.querySelectorAll("img")).filter((img) => {
        const rect = img.getBoundingClientRect();
        return rect.width >= 90 && rect.height >= 90 && rect.left < window.innerWidth * 0.72 && rect.top > 120;
      });

      const selectedImgs = allImgs.filter((img) => {
        let el = img;
        for (let depth = 0; depth < 6 && el; depth++) {
          if (el.getAttribute("aria-selected") === "true") return true;
          const cs = window.getComputedStyle(el);
          if (
            cs.borderColor.includes("20, 115, 230") ||
            cs.outlineColor.includes("20, 115, 230") ||
            cs.boxShadow.includes("20, 115, 230")
          ) {
            return true;
          }
          el = el.parentElement;
        }
        return false;
      });

      if (selectedImgs.length === 0) {
        return "Не найдено выделенных фотографий. Кликните мышкой по нужному фото (чтобы появилась синяя рамка) и нажмите «Запустить».";
      }

      if (selectedImgs.length > 30) {
        return `Выделено слишком много фото (${selectedImgs.length} шт.). Выделите до 30 фото за один раз.`;
      }

      const getImageBase64 = (imgEl) => {
        return new Promise((resolve) => {
          const tempImg = new Image();
          tempImg.crossOrigin = "anonymous";
          tempImg.onload = () => {
            const canvas = document.createElement("canvas");
            const scale = 384 / Math.max(tempImg.naturalWidth, tempImg.naturalHeight, 1);
            canvas.width = Math.round(tempImg.naturalWidth * scale) || 384;
            canvas.height = Math.round(tempImg.naturalHeight * scale) || 384;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(tempImg, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", 0.78));
          };
          tempImg.onerror = () => {
            const canvas = document.createElement("canvas");
            canvas.width = 384;
            canvas.height = 384;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(imgEl, 0, 0, 384, 384);
            resolve(canvas.toDataURL("image/jpeg", 0.78));
          };
          tempImg.src = imgEl.src;
        });
      };

      const setNativeValue = (element, value) => {
        element.focus();
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
        element.blur();
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

      const FREE_VISION_MODELS = [
        "google/gemma-3-27b-it:free",
        "qwen/qwen2.5-vl-72b-instruct:free",
        "meta-llama/llama-4-maverick:free",
        "openrouter/free"
      ];

      let processedCount = 0;

      for (let i = 0; i < selectedImgs.length; i++) {
        if (await isStopped()) {
          return `Остановлено! Успешно заполнено фото: ${processedCount} из ${selectedImgs.length}.`;
        }

        const img = selectedImgs[i];
        img.scrollIntoView({ behavior: "smooth", block: "center" });

        if (selectedImgs.length > 1) {
          img.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
          img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
          img.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          await sleep(650);
        }

        if (await isStopped()) {
          return `Остановлено! Успешно заполнено фото: ${processedCount} из ${selectedImgs.length}.`;
        }

        const base64Image = await getImageBase64(img);

        const prompt = `Return ONLY a raw JSON object (no markdown, no backticks) with keys "title", "keywords", "category":
1. "title": Commercial English title up to 190 chars, NO period at the end, first letter capitalized, NO brand names. Must include: what is depicted + who is depicted (if person) + environment + lighting/atmosphere + ending with concept.
2. "keywords": Array of 54 single lowercase English search words (no phrases, no hyphens, no duplicates). First 10 words must be the most important core subjects. Strictly NO trash/AI words (overlayeffect, visual, designconcept, concept, shot, ai, generated, render).
3. "category": Integer: 6 or 12 for portraits/people, 2 for interiors/architecture, 5 for nature/landscapes, 7 for food, default 6.`;

        let rawContent = null;
        let lastError = "";

        for (const modelId of FREE_VISION_MODELS) {
          if (await isStopped()) {
            return `Остановлено! Успешно заполнено фото: ${processedCount} из ${selectedImgs.length}.`;
          }

          try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${key}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://contributor.stock.adobe.com",
                "X-Title": "My Fast Adobe Stock Tagger"
              },
              body: JSON.stringify({
                model: modelId,
                messages: [
                  {
                    role: "user",
                    content: [
                      { type: "text", text: prompt },
                      { type: "image_url", image_url: { url: base64Image } }
                    ]
                  }
                ],
                temperature: 0.25
              })
            });

            const data = await response.json();
            if (response.ok && data.choices?.[0]?.message?.content) {
              rawContent = data.choices[0].message.content;
              break;
            } else {
              lastError = `${modelId}: ${data.error?.message || response.status}`;
            }
          } catch (err) {
            lastError = `${modelId}: ${err.message}`;
          }
        }

        if (!rawContent) {
          return `Ошибка на фото ${i + 1}: не удалось получить ответ (${lastError}). Проверьте ключ sk-or-v1-...`;
        }

        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          return `Ошибка разбора ответа на фото ${i + 1}, попробуйте запустить ещё раз.`;
        }
        const parsed = JSON.parse(jsonMatch[0]);

        // Ищем поля строго в правой панели редактирования (x > 65% ширины экрана)
        const rightTextareas = Array.from(document.querySelectorAll("textarea")).filter((ta) => {
          const r = ta.getBoundingClientRect();
          return r.width > 120 && r.left > window.innerWidth * 0.65;
        });

        // 1. Заполняем Title (первое текстовое поле в правой панели)
        if (parsed.title) {
          let cleanTitle = String(parsed.title)
            .replace(/\bshot\b/gi, "photo")
            .replace(/[.!?]+$/g, "")
            .trim();
          cleanTitle = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
          cleanTitle = cleanTitle.slice(0, 198).replace(/[.!?]+$/g, "").trim();

          const titleInput = rightTextareas[0] || document.querySelector('textarea[name="title"], input[name="title"]');
          if (titleInput) {
            setNativeValue(titleInput, cleanTitle);
          }
        }

        // 2. Заполняем Keywords (второе текстовое поле в правой панели, ровно 49 слов)
        const singleWords = [];
        for (const rawWord of parsed.keywords || []) {
          const clean = String(rawWord).trim().toLowerCase().replace(/[^a-z]/g, "");
          if (clean && clean.length > 1 && !BANNED_WORDS.has(clean) && !singleWords.includes(clean)) {
            singleWords.push(clean);
          }
        }
        const finalKeywords = singleWords.slice(0, 49).join(", ");

        const kwInput = rightTextareas[1] || document.querySelector('textarea[name="keywords"]');
        if (kwInput && finalKeywords) {
          setNativeValue(kwInput, finalKeywords);
        }

        // 3. Выбираем категорию строго в правой панели
        const catCode = [2, 5, 6, 7, 12].includes(Number(parsed.category)) ? Number(parsed.category) : 6;
        const rightSelects = Array.from(document.querySelectorAll("select")).filter((s) => s.getBoundingClientRect().left > window.innerWidth * 0.65);
        const catSelect = rightSelects.find((s) => Array.from(s.options).some((o) => o.value === "6" || o.text.toLowerCase().includes("люди") || o.text.toLowerCase().includes("feeling"))) || rightSelects[0];
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

        // 4. Галочка "Созданный с помощью технологий искусственного интеллекта" СТРОГО в правой панели!
        if (shouldMarkAi) {
          const rightCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter((cb) => {
            const r = cb.getBoundingClientRect();
            return r.left > window.innerWidth * 0.65;
          });
          const aiCheckbox = rightCheckboxes.find((cb) => {
            const labelEl = cb.closest("label") || cb.parentElement;
            const txt = (labelEl?.textContent || "").toLowerCase();
            return txt.length < 150 && (txt.includes("generative ai") || txt.includes("искусственного интеллекта"));
          });
          if (aiCheckbox && !aiCheckbox.checked) {
            aiCheckbox.click();
          }
        }

        processedCount++;
        if (i < selectedImgs.length - 1) {
          await sleep(1200);
        }
      }

      return `Готово! Быстро заполнено фото: ${processedCount} из ${selectedImgs.length} (Title + 49 слов + категория).`;
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

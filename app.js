const storageKey = "exchange-comparator-state";

const sourceCurrencySelect = document.querySelector("#source-currency");
const amountInput = document.querySelector("#amount-input");
const amountLabel = document.querySelector("#amount-label");
const amountNote = document.querySelector("#amount-note");
const rateHint = document.querySelector("#rate-hint");
const resultsNote = document.querySelector("#results-note");
const syncStatus = document.querySelector("#sync-status");
const syncNowButton = document.querySelector("#sync-now");
const reloadCloudButton = document.querySelector("#reload-cloud");
const placesList = document.querySelector("#places-list");
const addPlaceButton = document.querySelector("#add-place");
const template = document.querySelector("#place-template");
const results = document.querySelector("#results");

const bestPlace = document.querySelector("#best-place");
const bestEur = document.querySelector("#best-eur");
const bestRate = document.querySelector("#best-rate");
const summaryDiffEur = document.querySelector("#summary-diff-eur");
const summaryDiffSource = document.querySelector("#summary-diff-source");
const appConfig = window.APP_CONFIG || {};
const hasSupabaseConfig =
  appConfig.supabaseUrl &&
  appConfig.supabaseKey &&
  !appConfig.supabaseUrl.includes("PASTE_YOUR") &&
  !appConfig.supabaseKey.includes("PASTE_YOUR");

const supabaseClient =
  hasSupabaseConfig && window.supabase
    ? window.supabase.createClient(appConfig.supabaseUrl, appConfig.supabaseKey)
    : null;

const cloudState = {
  UAH: [],
  USD: [],
};

let syncTimer = null;
let syncInFlight = false;
let suppressCloudSave = false;

const currencyLabels = {
  UAH: {
    amount: "Сума в UAH",
    amountNote: "Введи суму гривень, яку ти реально можеш обміняти.",
    rateHint: "Курс показує, скільки UAH ти платиш за 1 EUR.",
    fee: "Комісія в UAH",
    from: "З",
    rate: "Курс",
    effectiveRate: "Ефективний курс",
    lossVsBest: "Різниця від найдешевшого EUR",
    lossValue: "Втрати у UAH",
    bestEmpty: "Додай хоча б один обмінник",
    effectiveSummary: "Найдешевший EUR",
    resultsNote:
      "Для кожного місця видно, скільки EUR ти отримаєш з твоєї суми UAH і яка різниця з найдешевшим EUR.",
    placeDefault: "Місце",
  },
  USD: {
    amount: "Сума в USD",
    amountNote: "Введи суму доларів, яку ти реально можеш обміняти.",
    rateHint: "Курс показує, скільки USD ти платиш за 1 EUR.",
    fee: "Комісія в USD",
    from: "З",
    rate: "Курс",
    effectiveRate: "Ефективний курс",
    lossVsBest: "Різниця від найдешевшого EUR",
    lossValue: "Втрати у USD",
    bestEmpty: "Додай хоча б один обмінник",
    effectiveSummary: "Найдешевший EUR",
    resultsNote:
      "Для кожного місця видно, скільки EUR ти отримаєш з твоєї суми USD і яка різниця з найдешевшим EUR.",
    placeDefault: "Місце",
  },
};

function formatMoney(value, digits = 2) {
  return Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function updateSyncStatus(message, tone = "idle") {
  syncStatus.textContent = message;
  syncStatus.className = `sync-status sync-${tone}`;
}

function setSyncButtonsDisabled(disabled) {
  syncNowButton.disabled = disabled;
  reloadCloudButton.disabled = disabled;
}

function createPlaceRow(data = {}) {
  const fragment = template.content.cloneNode(true);
  const card = fragment.querySelector(".place-card");

  card.querySelector(".place-name").value = data.name || "";
  card.querySelector(".place-rate").value = data.rate || "";
  card.querySelector(".place-fee").value = data.fee ?? 0;

  card.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", handleInputChange);
  });

  card.querySelector(".remove-place").addEventListener("click", () => {
    card.remove();
    recalculate();
  });

  placesList.appendChild(fragment);
  updatePlaceLabels();
}

function collectPlaces() {
  const sourceCurrency = sourceCurrencySelect.value;

  return [...document.querySelectorAll(".place-card")].map((card, index) => {
    const name =
      card.querySelector(".place-name").value.trim() ||
      `${currencyLabels[sourceCurrency].placeDefault} ${index + 1}`;
    const rate = Number(card.querySelector(".place-rate").value);
    const fee = Number(card.querySelector(".place-fee").value || 0);

    return {
      name,
      rate,
      fee,
      valid: rate > 0,
    };
  });
}

function replacePlaces(places) {
  placesList.innerHTML = "";

  if (places.length) {
    places.forEach(createPlaceRow);
    return;
  }

  createPlaceRow({ name: `${currencyLabels[sourceCurrencySelect.value].placeDefault} 1` });
}

function saveState() {
  const state = {
    sourceCurrency: sourceCurrencySelect.value,
    amount: amountInput.value,
    places: collectPlaces().map(({ name, rate, fee }) => ({ name, rate, fee })),
  };

  localStorage.setItem(storageKey, JSON.stringify(state));
}

function renderEmptyState(message) {
  results.innerHTML = `<div class="empty-state">${message}</div>`;
}

function normalizeCloudRows(rows) {
  return rows.map((row) => ({
    name: row.place_name ?? row.name,
    rate: Number(row.rate),
    fee: Number(row.fee),
  }));
}

async function loadCloudState() {
  if (!supabaseClient) {
    updateSyncStatus("Хмарна синхронізація не налаштована", "idle");
    return;
  }

  setSyncButtonsDisabled(true);
  updateSyncStatus("Завантажую дані з Supabase...", "idle");

  const { data, error } = await supabaseClient
    .from("exchange_places")
    .select("base_currency, place_name, rate, fee")
    .order("id", { ascending: true });

  setSyncButtonsDisabled(false);

  if (error) {
    updateSyncStatus(`Помилка завантаження: ${error.message}`, "error");
    return;
  }

  cloudState.UAH = normalizeCloudRows(data.filter((row) => row.base_currency === "UAH"));
  cloudState.USD = normalizeCloudRows(data.filter((row) => row.base_currency === "USD"));

  const activeCurrency = sourceCurrencySelect.value;
  if (cloudState[activeCurrency].length) {
    suppressCloudSave = true;
    replacePlaces(cloudState[activeCurrency]);
    updatePlaceLabels();
    recalculate();
    suppressCloudSave = false;
  }

  updateSyncStatus("Дані з хмари завантажені", "ok");
}

async function saveCloudState() {
  if (!supabaseClient || syncInFlight) {
    return;
  }

  const sourceCurrency = sourceCurrencySelect.value;
  const places = collectPlaces()
    .filter((place) => place.valid)
    .map((place) => ({
      base_currency: sourceCurrency,
      place_name: place.name,
      rate: place.rate,
      fee: place.fee,
    }));

  syncInFlight = true;
  setSyncButtonsDisabled(true);
  updateSyncStatus("Зберігаю дані в Supabase...", "idle");

  const deleteResult = await supabaseClient
    .from("exchange_places")
    .delete()
    .eq("base_currency", sourceCurrency);

  if (deleteResult.error) {
    syncInFlight = false;
    setSyncButtonsDisabled(false);
    updateSyncStatus(`Помилка збереження: ${deleteResult.error.message}`, "error");
    return;
  }

  if (places.length) {
    const insertResult = await supabaseClient.from("exchange_places").insert(places);

    if (insertResult.error) {
      syncInFlight = false;
      setSyncButtonsDisabled(false);
      updateSyncStatus(`Помилка збереження: ${insertResult.error.message}`, "error");
      return;
    }
  }

  cloudState[sourceCurrency] = normalizeCloudRows(places);
  syncInFlight = false;
  setSyncButtonsDisabled(false);
  updateSyncStatus("Дані збережені в хмарі", "ok");
}

function queueCloudSave() {
  if (!supabaseClient || suppressCloudSave) {
    return;
  }

  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    saveCloudState();
  }, 900);
}

function updateSummary(bestOption) {
  const sourceCurrency = sourceCurrencySelect.value;
  const labels = currencyLabels[sourceCurrency];

  if (!bestOption) {
    bestPlace.textContent = labels.bestEmpty;
    bestEur.textContent = "0.00 EUR";
    bestRate.textContent = `${labels.effectiveSummary}: -`;
    summaryDiffEur.textContent = "0.00 EUR";
    summaryDiffSource.textContent = `0.00 ${sourceCurrency}`;
    return;
  }

  bestPlace.textContent = bestOption.name;
  bestEur.textContent = `${formatMoney(bestOption.eurReceived)} EUR`;
  bestRate.textContent = `${labels.effectiveSummary}: ${formatMoney(bestOption.effectiveRate, 4)} ${sourceCurrency} / EUR`;
}

function renderResults(amount, computedPlaces) {
  const sourceCurrency = sourceCurrencySelect.value;
  const labels = currencyLabels[sourceCurrency];

  if (!computedPlaces.length) {
    updateSummary(null);
    renderEmptyState("Додай точки обміну з коректним курсом, щоб побачити порівняння.");
    return;
  }

  const bestOption = computedPlaces[0];
  const worstOption = computedPlaces[computedPlaces.length - 1];
  const totalDiffEur = bestOption.eurReceived - worstOption.eurReceived;
  const totalDiffSource = totalDiffEur * bestOption.effectiveRate;
  updateSummary(bestOption);
  summaryDiffEur.textContent = `${formatMoney(totalDiffEur)} EUR`;
  summaryDiffSource.textContent = `${formatMoney(totalDiffSource)} ${sourceCurrency}`;

  results.innerHTML = computedPlaces
    .map((place, index) => {
      const lossEur = bestOption.eurReceived - place.eurReceived;
      const lossSource = lossEur * bestOption.effectiveRate;
      const badge = index === 0 ? '<span class="badge">Найдешевший EUR</span>' : "";

      return `
        <article class="result-card ${index === 0 ? "best" : ""}">
          <div class="result-header">
            <h3>${place.name}</h3>
            ${badge}
          </div>
          <div class="result-stats">
            <div>
              <div class="result-main">${formatMoney(place.eurReceived)} EUR</div>
              <p>${labels.from} ${formatMoney(amount)} ${sourceCurrency}</p>
            </div>
            <div class="result-meta">
              <p>${labels.rate}: ${formatMoney(place.rate, 4)} ${sourceCurrency} / EUR</p>
              <p>Комісія: ${formatMoney(place.fee)} ${sourceCurrency}</p>
            </div>
          </div>
          <div class="stat-row">
            <p>${labels.effectiveRate}</p>
            <p>${formatMoney(place.effectiveRate, 4)} ${sourceCurrency} / EUR</p>
          </div>
          <div class="stat-row">
            <p>${labels.lossVsBest}</p>
            <p class="${index === 0 ? "win-value" : "loss-value"}">
              ${index === 0 ? "0.00 EUR" : `${formatMoney(lossEur)} EUR`}
            </p>
          </div>
          <div class="stat-row">
            <p>${labels.lossValue}</p>
            <p class="${index === 0 ? "win-value" : "loss-value"}">
              ${index === 0 ? `0.00 ${sourceCurrency}` : `${formatMoney(lossSource)} ${sourceCurrency}`}
            </p>
          </div>
        </article>
      `;
    })
    .join("");
}

function recalculate() {
  const amount = Number(amountInput.value);
  const places = collectPlaces();

  saveState();
  cloudState[sourceCurrencySelect.value] = places
    .filter((place) => place.valid)
    .map(({ name, rate, fee }) => ({ name, rate, fee }));
  queueCloudSave();

  if (!(amount > 0)) {
    updateSummary(null);
    renderEmptyState("Введи суму більшу за нуль, щоб побачити порівняння.");
    return;
  }

  const computedPlaces = places
    .filter((place) => place.valid)
    .map((place) => {
      const spendable = Math.max(amount - place.fee, 0);
      const eurReceived = spendable / place.rate;
      const effectiveRate = eurReceived > 0 ? amount / eurReceived : 0;

      return {
        ...place,
        eurReceived,
        effectiveRate,
      };
    })
    .sort((left, right) => left.effectiveRate - right.effectiveRate);

  renderResults(amount, computedPlaces);
}

function handleInputChange() {
  recalculate();
}

function updatePlaceLabels() {
  const sourceCurrency = sourceCurrencySelect.value;
  const labels = currencyLabels[sourceCurrency];

  amountLabel.textContent = labels.amount;
  amountNote.textContent = labels.amountNote;
  rateHint.textContent = labels.rateHint;
  resultsNote.textContent = labels.resultsNote;

  document.querySelectorAll(".place-card").forEach((card) => {
    card.querySelector(".rate-label").textContent = `Курс (${sourceCurrency} / EUR)`;
    card.querySelector(".fee-label").textContent = labels.fee;
  });
}

function loadSavedState() {
  const raw = localStorage.getItem(storageKey);

  if (!raw) {
    sourceCurrencySelect.value = "UAH";
    createPlaceRow({ name: "Місце 1" });
    createPlaceRow({ name: "Місце 2" });
    updatePlaceLabels();
    recalculate();
    return;
  }

  try {
    const state = JSON.parse(raw);

    sourceCurrencySelect.value = state.sourceCurrency || "UAH";
    amountInput.value = state.amount || 10000;
    placesList.innerHTML = "";

    if (Array.isArray(state.places) && state.places.length) {
      state.places.forEach(createPlaceRow);
    } else {
      createPlaceRow({ name: "Місце 1" });
    }
  } catch (error) {
    sourceCurrencySelect.value = "UAH";
    createPlaceRow({ name: "Місце 1" });
  }

  updatePlaceLabels();
  recalculate();
}

amountInput.addEventListener("input", handleInputChange);
sourceCurrencySelect.addEventListener("change", () => {
  if (cloudState[sourceCurrencySelect.value].length) {
    suppressCloudSave = true;
    replacePlaces(cloudState[sourceCurrencySelect.value]);
    suppressCloudSave = false;
  }
  updatePlaceLabels();
  recalculate();
});
addPlaceButton.addEventListener("click", () => {
  createPlaceRow();
  recalculate();
});
syncNowButton.addEventListener("click", () => {
  saveCloudState();
});
reloadCloudButton.addEventListener("click", () => {
  loadCloudState();
});

loadSavedState();

if (supabaseClient) {
  updateSyncStatus("Supabase підключено", "ok");
  loadCloudState();
} else {
  updateSyncStatus("Встав URL і Publishable key у config.js", "idle");
  setSyncButtonsDisabled(true);
}

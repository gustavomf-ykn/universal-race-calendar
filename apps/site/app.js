/* global document, fetch, FormData, URLSearchParams, window */

const DEFAULT_API_BASE_URL = "https://universal-race-calendar.onrender.com";
const params = new URLSearchParams(window.location.search);
const apiBaseUrl = (params.get("api") || DEFAULT_API_BASE_URL).replace(/\/$/, "");

const form = document.querySelector("#filters");
const eventsEl = document.querySelector("#events");
const statusEl = document.querySelector("#status");
const summaryEl = document.querySelector("#summary");
const apiLink = document.querySelector("#apiLink");

apiLink.href = `${apiBaseUrl}/docs`;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadEvents();
});

loadEvents();

async function loadEvents() {
  const query = new URLSearchParams({
    sourceType: "ticketsports",
    limit: "100",
    sort: "date_asc",
  });
  for (const [key, value] of new FormData(form).entries()) {
    const text = String(value).trim();
    if (text) query.set(key, key === "state" ? text.toUpperCase() : text);
  }

  const url = `${apiBaseUrl}/v1/events?${query.toString()}`;
  statusEl.textContent = "Carregando eventos...";
  eventsEl.replaceChildren();

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`API respondeu ${response.status}`);
    const payload = await response.json();
    renderEvents(payload.data ?? []);
    const total = payload.pagination?.total ?? 0;
    summaryEl.textContent = `${total} eventos publicados na API`;
    statusEl.textContent = payload.data?.length ? `Mostrando ${payload.data.length} eventos` : "Nenhum evento encontrado";
  } catch (error) {
    summaryEl.textContent = "Nao foi possivel carregar a API";
    statusEl.textContent = error instanceof Error ? error.message : "Erro desconhecido";
  }
}

function renderEvents(events) {
  eventsEl.replaceChildren(
    ...events.map((event) => {
      const article = document.createElement("article");
      article.className = "event";

      const image = document.createElement("img");
      image.alt = event.name;
      image.src =
        event.mainImageUrl ||
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%23e6eaf0'/%3E%3Cpath d='M140 230c82-86 160-86 240 0 42 45 83 45 120 0' fill='none' stroke='%230f766e' stroke-width='18' stroke-linecap='round'/%3E%3Ccircle cx='220' cy='126' r='34' fill='%230f766e'/%3E%3C/svg%3E";

      const body = document.createElement("div");
      body.className = "event-body";

      const title = document.createElement("h2");
      title.textContent = event.name;

      const meta = document.createElement("div");
      meta.className = "meta";
      appendChip(meta, formatDate(event.date));
      appendChip(meta, [event.city, event.state].filter(Boolean).join(" / ") || event.locationName || "Local a confirmar");
      appendChip(meta, event.eventStatus);

      const chips = document.createElement("div");
      chips.className = "chips";
      for (const distance of event.distances ?? []) appendChip(chips, distance);
      if (event.lowestPrice != null) {
        const price = document.createElement("span");
        price.className = "price";
        price.textContent = `A partir de ${formatMoney(event.lowestPrice, event.currency || "BRL")}`;
        chips.append(price);
      }

      const link = document.createElement("a");
      link.href = event.registrationUrl || event.officialUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Inscricao";

      body.append(title, meta, chips, link);
      article.append(image, body);
      return article;
    }),
  );
}

function appendChip(parent, value) {
  if (!value) return;
  const chip = document.createElement("span");
  chip.textContent = value;
  parent.append(chip);
}

function formatDate(value) {
  if (!value) return "Data a confirmar";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function formatMoney(value, currency) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(value);
}

const $ = selector => document.querySelector(selector);
const apiBase = ($('meta[name="api-base"]')?.content || "").replace(/\/$/, "");
const apiUrl = path => `${apiBase}${path}`;
const show = element => element?.classList.remove("hidden");
const hide = element => element?.classList.add("hidden");

async function apiFetch(path, options = {}) {
  let response;
  try {
    response = await fetch(apiUrl(path), options);
  } catch (_) {
    throw new Error("A API está indisponível. No plano gratuito, o servidor pode levar cerca de um minuto para iniciar.");
  }
  let payload = null;
  try { payload = await response.json(); } catch (_) { /* resposta sem JSON */ }
  if (!response.ok) throw new Error(payload?.detail || `Falha HTTP ${response.status}.`);
  return payload;
}

document.querySelectorAll(".tab-button").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".tab-button").forEach(item => item.classList.toggle("active", item === button));
  document.querySelectorAll(".tab-content").forEach(item => item.classList.toggle("hidden", item.id !== button.dataset.tab));
}));

const eventsState = {page: 1, limit: 50, totalPages: 1, selectedUrls: new Set()};

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = String(value).slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function setCatalogMessage(text, kind = "") {
  const box = $("#catalog-message");
  box.textContent = text;
  box.className = `alert ${kind}`.trim();
  show(box);
}

async function loadEvents() {
  const params = new URLSearchParams({
    page: eventsState.page,
    limit: eventsState.limit,
    search: $("#events-search").value.trim(),
    state: $("#events-state").value.trim().toUpperCase(),
    id_status: $("#events-id-status").value,
    date_from: $("#events-date-from").value,
  });
  if ($("#events-date-to").value) params.set("date_to", $("#events-date-to").value);
  const data = await apiFetch(`/api/events?${params}`);
  const body = $("#events-body");
  body.replaceChildren();
  data.items.forEach(event => {
    const row = document.createElement("tr");
    const checkCell = document.createElement("td");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = eventsState.selectedUrls.has(event.event_url);
    check.addEventListener("change", () => check.checked ? eventsState.selectedUrls.add(event.event_url) : eventsState.selectedUrls.delete(event.event_url));
    checkCell.append(check);
    const values = [formatDate(event.start_date), event.event_id || "", event.name, [event.city, event.state].filter(Boolean).join(" / "), event.id_status];
    row.append(checkCell, ...values.map(value => { const cell = document.createElement("td"); cell.textContent = value; return cell; }));
    const linkCell = document.createElement("td");
    const link = document.createElement("a");
    link.href = event.event_url; link.target = "_blank"; link.rel = "noopener"; link.textContent = "Abrir";
    linkCell.append(link); row.append(linkCell); body.append(row);
  });
  eventsState.totalPages = Math.max(1, Math.ceil(data.total / data.limit));
  $("#events-count").textContent = `${data.total} provas`;
  $("#events-page").textContent = `Página ${data.page} de ${eventsState.totalPages}`;
  $("#events-prev").disabled = eventsState.page <= 1;
  $("#events-next").disabled = eventsState.page >= eventsState.totalPages;
  data.items.length ? hide($("#events-empty")) : show($("#events-empty"));
}

async function pollUtilityJob(jobId, completedMessage) {
  const job = await apiFetch(`/api/jobs/${jobId}`);
  const counters = job.counters || {};
  setCatalogMessage(`${job.stage} (${Math.round(job.progress || 0)}%)`);
  if (["completed", "completed_with_warnings"].includes(job.status)) {
    const suffix = job.warnings?.length ? ` ${job.warnings.length} aviso(s).` : "";
    setCatalogMessage(`${completedMessage}${suffix}`, job.warnings?.length ? "alert-warning" : "");
    await loadEvents();
    return;
  }
  if (job.status === "failed") {
    setCatalogMessage(job.error || "Não foi possível concluir.", "alert-error");
    return;
  }
  window.setTimeout(() => pollUtilityJob(jobId, completedMessage), 900);
}

$("#discover-form").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const body = {date_from: $("#events-date-from").value || null, date_to: $("#events-date-to").value || null};
    const job = await apiFetch("/api/events/discover", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    pollUtilityJob(job.job_id, "Catálogo atualizado.");
  } catch (error) { setCatalogMessage(error.message, "alert-error"); }
});

$("#metadata-selected").addEventListener("click", async () => {
  if (!eventsState.selectedUrls.size) return setCatalogMessage("Selecione ao menos uma prova.", "alert-error");
  try {
    const job = await apiFetch("/api/events/metadata", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({scope: {mode: "selected", event_urls: [...eventsState.selectedUrls]}, enrich_roadrunners: false}),
    });
    pollUtilityJob(job.job_id, "Metadados atualizados.");
  } catch (error) { setCatalogMessage(error.message, "alert-error"); }
});

let eventsSearchTimer;
$("#events-search").addEventListener("input", () => { clearTimeout(eventsSearchTimer); eventsSearchTimer = setTimeout(() => { eventsState.page = 1; loadEvents(); }, 300); });
$("#events-state").addEventListener("input", () => { eventsState.page = 1; loadEvents(); });
$("#events-id-status").addEventListener("change", () => { eventsState.page = 1; loadEvents(); });
$("#events-refresh").addEventListener("click", loadEvents);
$("#events-prev").addEventListener("click", () => { if (eventsState.page > 1) { eventsState.page--; loadEvents(); } });
$("#events-next").addEventListener("click", () => { if (eventsState.page < eventsState.totalPages) { eventsState.page++; loadEvents(); } });
$("#simple-export").href = apiUrl("/api/events/export/simple");
$("#full-export").href = apiUrl("/api/events/export/full");

const labels = {
  event_id: "ID da prova", event: "Evento", event_date: "Data do evento", city: "Cidade", state: "UF",
  modality: "Modalidade", distance_km: "Distância em km", gender: "Gênero",
  overall_position: "Posição geral", category_position: "Posição na categoria",
  category: "Categoria", bib: "Número", name: "Nome", team: "Equipe",
  pace: "Pace", time: "Tempo", gap: "Gap", source_url: "URL de origem", extracted_at: "Data e hora da extração",
};
const preferredColumns = Object.keys(labels);
const internalColumns = new Set(["category_code", "modality_value"]);
const resultState = {jobId: null, page: 1, pageSize: 25, search: "", gender: "", modality: "", category: "", eventId: "", sortBy: "distance_km", sortDir: "asc", columns: [], totalPages: 1};
const state = resultState;

function updateScopeUI() {
  const scope = $("#result-scope").value;
  $("#event-url").classList.toggle("hidden", scope !== "single");
  $("#result-date-from-label").classList.toggle("hidden", scope !== "all");
  $("#result-date-to-label").classList.toggle("hidden", scope !== "all");
  $("#confirm-all-label").classList.toggle("hidden", scope !== "all");
}
$("#result-scope").addEventListener("change", updateScopeUI);

function setProgress(job) {
  const value = Math.max(0, Math.min(100, job.progress || 0));
  $("#progress-bar").style.width = `${value}%`; $("#progress-percent").textContent = `${value}%`;
  $("#progress-status").textContent = job.stage || job.status;
  $("#progress-title").textContent = job.status === "failed" ? "Não foi possível concluir" : "Extraindo resultados";
}

function renderSummary(job) {
  const counters = job.counters || {};
  $("#event-name").textContent = job.event || (counters.events_total ? `${counters.events_total} provas no escopo` : "Evento");
  $("#modality-count").textContent = counters.events_completed ?? job.modality_count ?? "—";
  $("#expected-total").textContent = job.total_expected ?? "—";
  $("#extracted-total").textContent = job.total_extracted ?? counters.athletes_extracted ?? 0;
  $("#female-total").textContent = job.by_gender?.Feminino ?? 0; $("#male-total").textContent = job.by_gender?.Masculino ?? 0;
  if (job.warnings?.length) {
    const list = document.createElement("ul");
    job.warnings.forEach(text => { const item = document.createElement("li"); item.textContent = text; list.append(item); });
    $("#warnings").replaceChildren(list); show($("#warnings"));
  } else hide($("#warnings"));
  $("#download-button").href = apiUrl(`/api/jobs/${state.jobId}/download`);
  job.download_ready ? show($("#download-button")) : hide($("#download-button"));
  show($("#summary-panel"));
}

function populateSelect(id, values, allLabel) {
  const select = $(id); const current = select.value; select.replaceChildren(new Option(allLabel, ""));
  (values || []).forEach(value => select.add(new Option(value, value))); select.value = (values || []).includes(current) ? current : "";
}

function determineColumns(items) {
  if (!items.length) return resultState.columns.length ? resultState.columns : preferredColumns;
  const available = new Set(items.flatMap(item => Object.keys(item)).filter(key => !internalColumns.has(key)));
  return [...preferredColumns.filter(key => available.has(key)), ...[...available].filter(key => !preferredColumns.includes(key)).sort()];
}

function formatValue(key, value) {
  if (value === null || value === undefined || value === "") return "";
  if (key === "event_date") return formatDate(value);
  if (key === "extracted_at") { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("pt-BR"); }
  return String(value);
}

function renderHead() {
  $("#table-head").replaceChildren();
  resultState.columns.forEach(key => {
    const th = document.createElement("th"); const button = document.createElement("button"); button.type = "button";
    const active = resultState.sortBy === key; button.textContent = `${labels[key] || key.replaceAll("_", " ")}${active ? (resultState.sortDir === "asc" ? " ↑" : " ↓") : ""}`;
    button.addEventListener("click", () => { if (active) resultState.sortDir = resultState.sortDir === "asc" ? "desc" : "asc"; else { resultState.sortBy = key; resultState.sortDir = "asc"; } resultState.page = 1; loadResults(); });
    th.append(button); $("#table-head").append(th);
  });
}

function renderRows(items) {
  $("#table-body").replaceChildren();
  items.forEach(item => {
    const row = document.createElement("tr");
    resultState.columns.forEach(key => { const cell = document.createElement("td"); const value = formatValue(key, item[key]); if (key === "source_url" && value) { const link = document.createElement("a"); link.href = value; link.target = "_blank"; link.rel = "noopener"; link.textContent = "Abrir"; cell.append(link); } else cell.textContent = value; row.append(cell); });
    $("#table-body").append(row);
  });
  items.length ? hide($("#table-empty")) : show($("#table-empty"));
}

async function loadResults() {
  const params = new URLSearchParams({page: resultState.page, page_size: resultState.pageSize, search: resultState.search, gender: resultState.gender, modality: resultState.modality, category: resultState.category, event_id: resultState.eventId, sort_by: resultState.sortBy, sort_dir: resultState.sortDir});
  const data = await apiFetch(`/api/jobs/${resultState.jobId}/results?${params}`);
  resultState.columns = determineColumns(data.items); renderHead(); renderRows(data.items);
  populateSelect("#event-filter", data.facets.events, "Todas"); populateSelect("#gender-filter", data.facets.genders, "Todos"); populateSelect("#modality-filter", data.facets.modalities, "Todas"); populateSelect("#category-filter", data.facets.categories, "Todas");
  resultState.totalPages = Math.max(1, Math.ceil(data.filtered_total / data.page_size));
  $("#result-count").textContent = `${data.filtered_total} de ${data.total} resultados`; $("#page-indicator").textContent = `Página ${data.page} de ${resultState.totalPages}`;
  $("#previous-page").disabled = resultState.page <= 1; $("#next-page").disabled = resultState.page >= resultState.totalPages; show($("#results-panel"));
}

async function pollResultJob() {
  try {
    const job = await apiFetch(`/api/jobs/${resultState.jobId}`); setProgress(job);
    if (["completed", "completed_with_warnings"].includes(job.status)) {
      renderSummary(job); await loadResults(); $("#submit-button").disabled = false; return;
    }
    if (["failed", "interrupted"].includes(job.status)) {
      $("#form-error").textContent = job.error || "O trabalho foi interrompido."; show($("#form-error")); show($("#resume-button")); $("#submit-button").disabled = false; return;
    }
    window.setTimeout(pollResultJob, 800);
  } catch (error) { $("#form-error").textContent = error.message; show($("#form-error")); $("#submit-button").disabled = false; }
}

$("#scrape-form").addEventListener("submit", async event => {
  event.preventDefault(); hide($("#form-error")); hide($("#summary-panel")); hide($("#results-panel")); hide($("#warnings")); hide($("#resume-button"));
  const scopeMode = $("#result-scope").value;
  const scope = {mode: scopeMode};
  if (scopeMode === "single") scope.url = $("#event-url").value.trim();
  if (scopeMode === "selected") scope.event_urls = [...eventsState.selectedUrls];
  if (scopeMode === "all") { scope.date_from = $("#result-date-from").value || null; scope.date_to = $("#result-date-to").value || null; }
  try {
    $("#submit-button").disabled = true;
    const data = await apiFetch("/api/results/scrape", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({scope, confirm_all: scopeMode === "all" && $("#confirm-all").checked})});
    resultState.jobId = data.job_id; resultState.page = 1; resultState.columns = []; show($("#progress-panel")); pollResultJob();
  } catch (error) { $("#form-error").textContent = error.message; show($("#form-error")); $("#submit-button").disabled = false; }
});

$("#resume-button").addEventListener("click", async () => { try { await apiFetch(`/api/jobs/${resultState.jobId}/resume`, {method: "POST"}); hide($("#resume-button")); pollResultJob(); } catch (error) { $("#form-error").textContent = error.message; } });
let resultSearchTimer;
$("#search").addEventListener("input", event => { clearTimeout(resultSearchTimer); resultSearchTimer = setTimeout(() => { resultState.search = event.target.value.trim(); resultState.page = 1; loadResults(); }, 300); });
[["#event-filter", "eventId"], ["#gender-filter", "gender"], ["#modality-filter", "modality"], ["#category-filter", "category"], ["#page-size", "pageSize"]].forEach(([selector, key]) => $(selector).addEventListener("change", event => { resultState[key] = key === "pageSize" ? Number(event.target.value) : event.target.value; resultState.page = 1; loadResults(); }));
$("#previous-page").addEventListener("click", () => { if (resultState.page > 1) { resultState.page--; loadResults(); } });
$("#next-page").addEventListener("click", () => { if (resultState.page < resultState.totalPages) { resultState.page++; loadResults(); } });

updateScopeUI();
loadEvents().catch(() => show($("#events-empty")));

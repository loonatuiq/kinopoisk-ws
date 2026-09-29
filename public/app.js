"use strict";

/* ===== Настройки ===== */
// Ключ API в браузере не хранится: запросы идут на /api/search (см. src/worker.js).
const PAGE_SIZE = 10;
const CACHE_LIMIT = 30;
const FAVORITES_KEY = "kinopoisk-ws-favorites";
const IOS_HINT_KEY = "kinopoisk-ws-ios-hint-dismissed";

/* ===== Элементы ===== */
const $ = id => document.getElementById(id);
const searchForm = $("searchForm");
const searchInput = $("searchInput");
const clearBtn = $("clearBtn");
const tabsEl = $("tabs");
const searchTab = $("searchTab");
const favoritesTab = $("favoritesTab");
const favoriteCount = $("favoriteCount");
const statusEl = $("status");
const results = $("results");
const moreBtn = $("moreBtn");
const convertForm = $("convertForm");
const urlInput = $("urlInput");
const directResult = $("directResult");
const installBtn = $("installBtn");
const iosHint = $("iosHint");

/* ===== Хранилище (не падает в приватном режиме и при переполнении) ===== */
const storage = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
};

/* ===== Нормализация данных API ===== */
function pickTitle(raw) {
  const n = raw.name;
  const candidates = [typeof n === "string" ? n : n?.ru, n?.en, raw.alternativeName, raw.enName];
  const found = candidates.find(v => typeof v === "string" && v.trim());
  return found ? found.trim() : "Без названия";
}

function pickPoster(raw) {
  const p = raw.poster;
  if (typeof p === "string") return p;
  // Для превью 72px берём маленькую картинку, а не оригинал
  return p?.previewUrl || p?.url || p?.preview || "";
}

function pickRating(raw) {
  const r = raw.rating;
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    const kp = Number(r.kp);
    const imdb = Number(r.imdb);
    if (kp > 0) return `КП: ${kp.toFixed(1)}`;
    if (imdb > 0) return `IMDb: ${imdb.toFixed(1)}`;
    return "";
  }
  const n = Number(r);
  return n > 0 ? `КП: ${n.toFixed(1)}` : "";
}

const TYPE_LABELS = {
  movie: "Фильм",
  series: "Сериал",
  "tv-series": "Сериал",
  "animated-series": "Мультсериал",
  cartoon: "Мультфильм",
  anime: "Аниме",
  "tv-show": "Шоу"
};

function pickType(raw) {
  if (raw.isSeries === true) return "Сериал";
  const t = raw.type;
  if (typeof t !== "string") return "";
  return TYPE_LABELS[t] || t;
}

function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id ?? raw.kinopoiskId ?? raw.kinopoisk_id ?? raw.externalId?.kp;
  if (!id) return null;
  return {
    id: String(id),
    name: pickTitle(raw),
    year: raw.year ?? raw.releaseYear ?? "",
    type: pickType(raw),
    rating: pickRating(raw),
    poster: pickPoster(raw)
  };
}

function wsUrl(id) {
  return `https://www.kinopoisk.ws/film/${encodeURIComponent(id)}/`;
}

/* ===== Состояние ===== */
const state = {
  view: "search",   // "search" | "favorites"
  query: "",
  items: [],        // результаты поиска (отдельно от избранного)
  page: 0,
  pages: 0,
  total: 0,
  loading: false,
  error: "",
  controller: null
};

let favorites = [];        // новые сверху
let favIds = new Set();
const pageCache = new Map(); // "запрос|страница" -> { items, pages, total }

function loadFavorites() {
  const raw = storage.read(FAVORITES_KEY, []);
  const seen = new Set();
  const list = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const m = normalize(item);
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      list.push(m);
    }
  }
  favorites = list;
  favIds = seen;
}

function saveFavorites() {
  return storage.write(FAVORITES_KEY, favorites);
}

function updateFavoriteCount() {
  favoriteCount.textContent = favorites.length ? ` (${favorites.length})` : "";
}

function findMovie(id) {
  return state.items.find(m => m.id === id) || favorites.find(m => m.id === id);
}

/* ===== Вспомогательное для DOM ===== */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(text, isError = false) {
  if (statusEl.textContent !== text) statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function createPlaceholder() {
  return h("div", "poster no-poster", "Нет постера");
}

function applyFavState(btn, active) {
  btn.classList.toggle("active", active);
  btn.setAttribute("aria-pressed", String(active));
  btn.textContent = active ? "★ В избранном" : "☆ В избранное";
}

function createCard(m) {
  const card = h("article", "card");
  card.dataset.id = m.id;

  if (m.poster) {
    const img = document.createElement("img");
    img.className = "poster";
    img.src = m.poster;
    img.alt = "";
    img.width = 72;
    img.height = 108;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => img.replaceWith(createPlaceholder()), { once: true });
    card.append(img);
  } else {
    card.append(createPlaceholder());
  }

  const info = h("div", "info");
  info.append(h("div", "title", m.name));
  info.append(h("div", "meta", [m.year, m.type].filter(Boolean).join(" · ")));
  if (m.rating) info.append(h("div", "rating", m.rating));

  const actions = h("div", "actions");

  const open = h("a", "btn btn-quiet", "Открыть .ws");
  open.href = wsUrl(m.id);
  open.target = "_blank";
  open.rel = "noopener noreferrer";

  const fav = h("button", "btn btn-quiet favorite");
  fav.type = "button";
  fav.dataset.action = "fav";
  fav.setAttribute("aria-label", `Избранное: ${m.name}`);
  applyFavState(fav, favIds.has(m.id));

  actions.append(open, fav);
  info.append(actions);
  card.append(info);
  return card;
}

function createSkeleton() {
  const card = h("div", "card skeleton");
  card.setAttribute("aria-hidden", "true");
  card.append(h("div", "poster"));
  const info = h("div", "info");
  for (const width of ["70%", "40%", "25%"]) {
    const line = h("div", "line");
    line.style.width = width;
    info.append(line);
  }
  card.append(info);
  return card;
}

/* ===== Отрисовка ===== */
function updateStatus() {
  if (state.view === "favorites") {
    setStatus(favorites.length ? `В избранном: ${favorites.length}` : "В избранном пока ничего нет.");
    return;
  }
  if (state.loading) {
    setStatus(state.items.length ? "Загружаю ещё…" : "Ищу…");
    return;
  }
  if (state.error) {
    setStatus(state.error, true);
    return;
  }
  if (!state.query) {
    setStatus("");
    return;
  }
  setStatus(state.items.length
    ? `Показано ${state.items.length} из ${Math.max(state.total, state.items.length)}`
    : "Ничего не найдено. Проверь написание или попробуй другое название.");
}

function updateMoreControls() {
  moreBtn.hidden = state.view !== "search" || state.loading || state.page >= state.pages;
  updateStatus();
}

function render() {
  const inFavorites = state.view === "favorites";
  const list = inFavorites ? favorites : state.items;

  results.replaceChildren();

  if (!inFavorites && state.loading && !list.length) {
    for (let i = 0; i < 3; i++) results.append(createSkeleton());
  } else if (list.length) {
    const fragment = document.createDocumentFragment();
    for (const m of list) fragment.append(createCard(m));
    results.append(fragment);
  } else if (inFavorites) {
    results.append(h("div", "empty", "Нажми «☆ В избранное» у фильма, и он появится здесь."));
  } else if (!state.query && !state.error) {
    results.append(h("div", "empty", "Введи название фильма или сериала, например «Интерстеллар»."));
  }

  results.setAttribute("aria-busy", String(state.loading));
  updateMoreControls();
}

function showView(view) {
  state.view = view;
  const isSearch = view === "search";
  searchTab.setAttribute("aria-selected", String(isSearch));
  favoritesTab.setAttribute("aria-selected", String(!isSearch));
  results.setAttribute("aria-labelledby", isSearch ? "searchTab" : "favoritesTab");
}

/* ===== Избранное ===== */
function toggleFavorite(movie) {
  const id = movie.id;
  if (favIds.has(id)) {
    favorites = favorites.filter(m => m.id !== id);
    favIds.delete(id);
  } else {
    favorites.unshift({ ...movie });
    favIds.add(id);
  }
  const saved = saveFavorites();
  syncFavoriteUI(id);
  if (!saved) setStatus("Не удалось сохранить избранное: хранилище браузера недоступно.", true);
}

// Обновляем только затронутую кнопку, а не перерисовываем список целиком
function syncFavoriteUI(id) {
  updateFavoriteCount();
  const card = [...results.children].find(c => c.dataset && c.dataset.id === id);
  if (!card) return;

  const active = favIds.has(id);
  if (state.view === "favorites" && !active) {
    const neighbour = card.nextElementSibling || card.previousElementSibling;
    card.remove();
    if (!favorites.length) {
      render();
      favoritesTab.focus();
    } else {
      updateStatus();
      (neighbour?.querySelector("[data-action='fav']") || favoritesTab).focus();
    }
    return;
  }
  applyFavState(card.querySelector("[data-action='fav']"), active);
}

function syncAllFavoriteButtons() {
  for (const card of results.children) {
    const btn = card.querySelector?.("[data-action='fav']");
    if (btn) applyFavState(btn, favIds.has(card.dataset.id));
  }
}

results.addEventListener("click", e => {
  const btn = e.target.closest("[data-action='fav']");
  if (!btn) return;
  const card = btn.closest(".card");
  const movie = card && findMovie(card.dataset.id);
  if (movie) toggleFavorite(movie);
});

/* ===== Запросы к API ===== */
async function fetchPage(q, page, signal) {
  const key = `${q.toLowerCase()}|${page}`;
  if (pageCache.has(key)) return pageCache.get(key);

  const url = new URL("/api/search", location.origin);
  url.searchParams.set("query", q);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(PAGE_SIZE));

  let response;
  try {
    response = await fetch(url, { signal });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new Error(navigator.onLine
      ? "Не удалось связаться с сервером. Попробуй ещё раз."
      : "Нет соединения с интернетом.");
  }

  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json()).error || ""; } catch { /* тело не JSON */ }
    if (response.status === 429) throw new Error("Превышен лимит запросов API. Попробуй чуть позже.");
    throw new Error(detail ? `Ошибка сервера: ${detail}` : `Ошибка сервера: HTTP ${response.status}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Сервер вернул некорректный ответ.");
  }

  const isArray = Array.isArray(data);
  const docs = isArray ? data : (data.docs ?? data.results ?? []);
  const items = docs.map(normalize).filter(Boolean);
  const total = isArray ? items.length : (Number(data.total) || items.length);
  const pages = isArray ? 1 : (Number(data.pages) || Math.ceil(total / PAGE_SIZE) || 1);

  const entry = { items, pages, total };
  pageCache.set(key, entry);
  if (pageCache.size > CACHE_LIMIT) pageCache.delete(pageCache.keys().next().value);
  return entry;
}

async function searchMovies() {
  const q = searchInput.value.trim();
  showView("search");

  if (state.controller) state.controller.abort();

  if (!q) {
    Object.assign(state, {
      controller: null, loading: false, query: "", items: [],
      page: 0, pages: 0, total: 0, error: "Введи название фильма или сериала."
    });
    render();
    searchInput.focus();
    return;
  }

  const controller = new AbortController();
  Object.assign(state, {
    controller, loading: true, query: q, items: [],
    page: 0, pages: 0, total: 0, error: ""
  });
  render();

  try {
    const data = await fetchPage(q, 1, controller.signal);
    if (controller !== state.controller) return;
    state.items = [...data.items];
    state.page = 1;
    state.pages = data.pages;
    state.total = data.total;
  } catch (e) {
    if (controller.signal.aborted || controller !== state.controller) return;
    state.error = e.message || "Не удалось выполнить поиск.";
  }

  if (controller !== state.controller) return;
  state.loading = false;
  state.controller = null;
  render();
}

async function loadMore() {
  if (state.loading || state.view !== "search" || state.page >= state.pages) return;

  const controller = new AbortController();
  const nextPage = state.page + 1;
  state.controller = controller;
  state.loading = true;
  state.error = "";
  updateMoreControls();

  try {
    const data = await fetchPage(state.query, nextPage, controller.signal);
    if (controller !== state.controller) return;
    const known = new Set(state.items.map(m => m.id));
    const fresh = data.items.filter(m => !known.has(m.id));
    state.items.push(...fresh);
    state.page = nextPage;
    state.pages = data.pages;
    state.total = data.total;
    if (state.view === "search") results.append(...fresh.map(m => createCard(m)));
  } catch (e) {
    if (controller.signal.aborted || controller !== state.controller) return;
    state.error = e.message || "Не удалось загрузить продолжение.";
  }

  if (controller !== state.controller) return;
  state.loading = false;
  state.controller = null;
  updateMoreControls();
}

/* ===== События интерфейса ===== */
searchForm.addEventListener("submit", e => {
  e.preventDefault();
  searchMovies();
});

searchInput.addEventListener("input", () => {
  clearBtn.hidden = !searchInput.value;
});

clearBtn.addEventListener("click", () => {
  searchInput.value = "";
  clearBtn.hidden = true;
  searchInput.focus();
});

searchTab.addEventListener("click", () => {
  if (state.view === "search") return;
  showView("search");
  render();
});

favoritesTab.addEventListener("click", () => {
  if (state.view === "favorites") return;
  showView("favorites");
  render();
});

tabsEl.addEventListener("keydown", e => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const next = state.view === "search" ? favoritesTab : searchTab;
  next.focus();
  next.click();
});

moreBtn.addEventListener("click", loadMore);

// Избранное изменили в другой вкладке браузера
window.addEventListener("storage", e => {
  if (e.key !== FAVORITES_KEY) return;
  loadFavorites();
  updateFavoriteCount();
  if (state.view === "favorites") render();
  else syncAllFavoriteButtons();
});

/* ===== Конвертер ссылок ===== */
const KP_HOST = /(^|\.)kinopoisk\.ru$/i;
const KP_PATH = /\/(?:film|series|movie)\/(\d+)/;

function convertUrl(input) {
  let value = input.trim();
  if (!value) throw new Error("Вставь ссылку на фильм с kinopoisk.ru");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "https://" + value;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Это не похоже на ссылку. Вставь адрес целиком.");
  }
  if (!/^https?:$/.test(url.protocol) || !KP_HOST.test(url.hostname)) {
    throw new Error("Нужна ссылка на kinopoisk.ru");
  }
  const match = url.pathname.match(KP_PATH);
  if (!match) {
    throw new Error("В ссылке нет номера фильма. Она должна выглядеть так: kinopoisk.ru/film/123456/");
  }
  return wsUrl(match[1]);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* пробуем запасной вариант */ }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;top:0;left:0";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

convertForm.addEventListener("submit", e => {
  e.preventDefault();
  directResult.replaceChildren();
  directResult.classList.remove("error");

  try {
    const link = convertUrl(urlInput.value);

    const text = h("div", null, link);
    const actions = h("div", "direct-actions");

    const open = h("a", "btn", "Открыть");
    open.href = link;
    open.target = "_blank";
    open.rel = "noopener noreferrer";

    const copy = h("button", "btn btn-quiet", "Копировать");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      const ok = await copyText(link);
      copy.textContent = ok ? "Скопировано" : "Не удалось скопировать";
      setTimeout(() => { copy.textContent = "Копировать"; }, 1600);
    });

    actions.append(open, copy);
    directResult.append(text, actions);
  } catch (err) {
    directResult.classList.add("error");
    directResult.textContent = err.message || "Некорректная ссылка.";
  }
  directResult.hidden = false;
});

/* ===== Установка PWA ===== */
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener("appinstalled", () => {
  installBtn.hidden = true;
  iosHint.hidden = true;
});

// В iOS нет beforeinstallprompt, поэтому показываем подсказку
if (isIOS && !isStandalone && !storage.read(IOS_HINT_KEY, false)) {
  iosHint.hidden = false;
}
$("iosHintClose").addEventListener("click", () => {
  iosHint.hidden = true;
  storage.write(IOS_HINT_KEY, true);
});

/* ===== Service Worker ===== */
if ("serviceWorker" in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  // Новая версия воркера активировалась: перезагружаем страницу, чтобы взять свежий код
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./sw.js", { updateViaCache: "none" })
      .then(registration => registration.update())
      .catch(console.error);
  });
}

/* ===== Старт ===== */
loadFavorites();
updateFavoriteCount();
showView("search");
render();

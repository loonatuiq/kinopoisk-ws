// Единый Cloudflare Worker проекта:
//   /api/search  — прокси к poiskkino API (ключ хранится в секрете API_KEY, в браузер не попадает)
//   всё остальное — статические файлы из папки public/ (через binding ASSETS)

const UPSTREAM = "https://api.poiskkino.dev/v1.4/movie/search";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function handleSearch(request, url, env) {
  // Запросы с чужих сайтов не пускаем. Прямое открытие в адресной строке (none) разрешено для отладки.
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") {
    return json({ error: "Forbidden" }, 403);
  }

  if (!env.API_KEY) {
    return json({ error: "API_KEY не задан: добавь секрет в настройках Worker" }, 500);
  }

  const query = (url.searchParams.get("query") || "").trim().slice(0, 100);
  if (!query) return json({ error: "Пустой запрос" }, 400);

  const page = Math.min(Math.max(parseInt(url.searchParams.get("page"), 10) || 1, 1), 50);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit"), 10) || 10, 1), 20);

  const upstream = new URL(UPSTREAM);
  upstream.searchParams.set("query", query);
  upstream.searchParams.set("page", String(page));
  upstream.searchParams.set("limit", String(limit));

  let response;
  try {
    response = await fetch(upstream, {
      headers: { "X-API-KEY": env.API_KEY, "Accept": "application/json" },
      // Кэшируем удачные ответы на 5 минут, ошибки не кэшируем
      cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 300, "400-599": 0 } }
    });
  } catch {
    return json({ error: "API поиска недоступно" }, 502);
  }

  if (!response.ok) {
    if (response.status === 429) return json({ error: "Лимит запросов API" }, 429);
    return json({ error: `API поиска ответило ошибкой ${response.status}` }, 502);
  }

  return new Response(response.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300"
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/search") {
      if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
      return handleSearch(request, url, env);
    }

    return env.ASSETS.fetch(request);
  }
};

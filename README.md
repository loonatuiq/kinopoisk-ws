# Kinopoisk WS

PWA для поиска фильмов и сериалов. Находит фильм по названию и открывает его на Kinopoisk.ws. Есть избранное, конвертер ссылок kinopoisk.ru → kinopoisk.ws и установка на телефон.

Сайт и API-прокси работают как **один проект Cloudflare Workers**. Деплой автоматический: любой коммит в `main` публикуется сам.

## Структура

```
wrangler.jsonc        настройки проекта Cloudflare (имя, папка со статикой)
src/worker.js         /api/search: прокси к poiskkino API, ключ хранится в секрете
public/               сайт
  index.html          разметка
  styles.css          стили
  app.js              вся логика приложения
  sw.js               service worker (офлайн-режим)
  manifest.webmanifest
  icons/
AGENTS.md             правила для ChatGPT/Codex при внесении правок
```

## Первый запуск

### 1. GitHub
1. Создай пустой репозиторий (например, `kinopoisk-ws`).
2. Загрузи в него содержимое этой папки: **Add file → Upload files**. Папки `public` и `src` должны лежать в корне репозитория.

### 2. Cloudflare
1. Открой **Workers & Pages → Create application → Import a repository** (подключение GitHub). Разреши Cloudflare доступ к репозиторию.
2. Имя проекта: `kinopoisk-ws`. Оно должно совпадать с `name` в `wrangler.jsonc`, иначе сборка упадёт.
3. Build command оставь пустым, Deploy command: `npx wrangler deploy`. Root directory: `/`.
4. Нажми **Save and Deploy**.

### 3. Ключ API
1. Получи ключ на poiskkino.dev.
2. В Cloudflare открой проект: **Settings → Variables and Secrets → Add**.
3. Тип **Secret**, имя ровно `API_KEY`, значение: твой ключ. Сохрани.

Тип обязательно **Secret**, а не Text: обычные переменные, которых нет в `wrangler.jsonc`, стираются при следующем деплое.

### 4. Проверка
- Открой `https://kinopoisk-ws.<твой-поддомен>.workers.dev/api/search?query=матрица`. Должен прийти JSON с фильмами.
- Открой сам сайт по адресу проекта и найди любой фильм.

## Как вносить изменения

1. Дай ChatGPT нужные файлы (или подключи репозиторий) и опиши задачу.
2. Закоммить результат в `main`. Cloudflare соберёт и опубликует сайт примерно за минуту.
3. Открой сайт и проверь. Изменения доходят до пользователей сразу: service worker берёт свежие файлы из сети.

Меняй `VERSION` в `public/sw.js` только если добавил или переименовал файлы из списка `APP_SHELL`.

## Локальный запуск (по желанию)

```
echo "API_KEY=твой_ключ" > .dev.vars
npx wrangler dev
```

Файл `.dev.vars` не попадает в git.

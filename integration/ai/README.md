# I02 — адаптер и локальная интеграция

Контракт и примеры: `../../docs/specs/TUTOR_API_V1.md`, `../../contracts/`.

adapter.mjs остаётся библиотекой преобразования запроса и ответа. I02.2 добавляет bridge.mjs (приватный журнал), worker-http.mjs/worker.mjs (один loopback worker), существующий Django JWT endpoint и панель редактора. Историческая инструкция — [в ветке archive](https://github.com/ranetochka14/lat-ai/tree/archive/docs/ai/I02_2_RUN.md); актуальный запуск — [RUNBOOK](../../docs/agent-handoff/RUNBOOK.md). Не использовать прежние demoEvents как историю пользователей.

Node22+. Runtime не имеет сторонних зависимостей. Ajv — только dev-зависимость проверки схем, версии фиксированы package-lock.

Из этой папки:

```text
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run check
```

Из корня репозитория:

```text
npm --prefix integration/ai ci --ignore-scripts --no-audit --no-fund
npm --prefix integration/ai test
npm --prefix integration/ai run check
```

`check` воспроизводит резерв/каталог/policy через modeloff ядро и два модельных формата через **синтетический генератор-заглушку**, валидирует schemas/examples и хеши core. Сеть, Django и настоящая модель не вызываются. Файлы SYNTHETIC — не результаты LLM и не оценки качества. `node check.mjs --write-examples` предназначен только автору контракта для осознанного обновления fixtures; обычная проверка их не переписывает.

Экспорт adapter.mjs:

- `prepareRequest(body,resolvedContext)` → неизменяемый снимок, request/trustedContext для Tutor либо ранний policy-ответ. resolvedContext получен сервером после JWT/object-access, не из пользовательского JSON.
- `toPublicResponse(prepared,coreAnswer)` → белый список публичных полей; принимает только уже проверенный ответ `Tutor.respond`, а не raw LLM.
- `errorResponse(error,body)` → `{status,body}`, без сырого текста ошибки.
- `fingerprintRequest(body)` → приватный SHA256 канонического нормализованного запроса для replay в bridge.mjs; не хранить как ключ без actor_id. Не реализует replay/доступ сам по себе.

Координатор сохраняет один Tutor на экземпляр модели. Для explain: prepare → при policy сразу toPublicResponse, иначе await tutor.respond(prepared.request,prepared.trustedContext) → toPublicResponse. Для hint тот же вызов **внутри** транзакции/сериализации `(actor_id,exercise_id)` и replay `(actor_id,request_id)`; атомарная запись ответа/события выполняется до отправки клиенту. adapter.mjs сам историю не меняет; bridge.mjs атомарно сохраняет выдачу hints и replay. Режим предназначен для ручной проверки взрослыми, а не для допуска учеников.

Основа core/src и core/data — LAT AI v10; происхождение и исходные хеши в UPSTREAM.json, явно изменённые файлы — в LOCAL_OVERRIDES.json. Автооценка добавлена поверх исходного ядра. Веса, runtime-логи и секреты не включены. Поддержка схем и успешные тесты не равны проверке смыслового качества модели или допуску детей. Детерминированный запрет полного разбора относится к hint level4, а не гарантии смысла свободного explain.

Название продукта — LAT AI. Технические формы имени и правила локального обновления описаны в `../../docs/agent-handoff/README.md`. Идентификаторы интеграции обновляются согласованно на обеих сторонах; совместимые псевдонимы прежних имён не поддерживаются.

Статический сервер отдаёт только index.html и assets/ до и после realpath. Приватные integration/.runtime не должны быть доступны, в том числе по коротким NTFS-именам. Полный npm test включает реальные localhost-проверки и запуск/аварийное завершение отдельного синтетического worker; живую модель не вызывает. Node SQLite пока выдаёт ExperimentalWarning; проверенная версия — 24.11.1.

# LAT AI — LEARN AND TALK

Учебная платформа с локальным ИИ-репетитором. Загружаешь конспект (TXT, PDF, DOCX, PPTX), выбираешь фрагмент, и ИИ делает мини-курс или тест с подсказками. Ответы по Python ИИ проверяет сам и ставит балл по понятным критериям.

Всё работает на одном компьютере: Django, закрытый Node-воркер и Qwen3.5-9B в LM Studio. Документы никуда не отправляются.

Ограничения: ИИ может ошибаться (это сказано и в интерфейсе); автооценка есть для 4 заданий по Python; запуск на Windows.

Запуск: START_MAIN.cmd. Проверки (155 тестов): docs/agent-handoff/RUNBOOK.md.

Разработка велась с ИИ-агентами; журнал решений: docs/agent-handoff. Архив экспериментов: ветка archive.

## Запуск на Windows

1. Клонируйте в короткий путь, например `C:\LAT\lat-ai`.
2. Подготовьте Python 3.12 x64, Node.js 22.13+ и LM Studio с CLI `lms`. Выполните `SETUP_PILOT.cmd`: зависимости из корневого `requirements.txt` и Node lockfile.
3. Импортируйте ранее выбранную Qwen3.5-9B-Q4_K_M в LM Studio (ключ `qwen3.5-9b`), включите сервер `127.0.0.1:1234`. Веса не входят в Git, скрипты их не скачивают. Без имеющейся модели `START_MAIN.cmd -WithoutModel` позволяет проверить интерфейс, но генерация ИИ не работает.
4. Выполните `START_MAIN.cmd -CheckOnly`, затем `START_MAIN.cmd`. Новый ПК использует `.runtime/i02`; существующий `.runtime/main-local.json` имеет приоритет и должен сохраняться при обновлении.
5. Сайт: http://127.0.0.1:5173/#/courses · Документы: http://127.0.0.1:5173/#/documents · Django admin: http://127.0.0.1:8000/admin/.

Остановка: Ctrl+C в окне запуска. Это стенд на loopback, не публичный хостинг. Тестовый пользователь `review@lat-ai.local` / `LatAI-Review-2026!` не администратор. Создание администратора нужной БД описано в runbook.

## Разработчикам и агентам

- [Решения, ограничения и следующая задача](docs/agent-handoff/README.md).
- [Запуск, БД, админка, проверки и восстановление](docs/agent-handoff/RUNBOOK.md).
- [Результаты проверок](docs/agent-handoff/VALIDATION.md).
- [Подробности MAIN](README-MAIN.txt).

`START_PILOT.cmd` использует другую БД (`.runtime/pilot`); `START_AI_REVIEW`, `START-FULL` и старые отчёты не задают текущий запуск. [Прежний README](docs/history/README-before-publication.md) сохранён только для истории.

# Запуск и проверка

Установка: [README](../../README.md). Команды выполняются из корня. Используйте короткий путь и `git config core.longpaths true`: исторические тестовые данные имеют длинные имена.

## MAIN и админка

`START_MAIN.cmd -CheckOnly` выводит Source, Database, Python и Node. Сохраните `.runtime/main-local.json` при обновлении: он указывает действующую БД. Без него новый ПК использует `.venv` и `.runtime/i02`. MAIN подготавливает выбранную БД и запускает четыре процесса; SETUP устанавливает только зависимости.

Сайт `http://127.0.0.1:5173`, API `http://127.0.0.1:8000/api/v1`, админка **http://127.0.0.1:8000/admin/**. После первого запуска/подготовки нового клона:

```powershell
.venv\Scripts\python.exe -B tools/pilot.py --runtime .runtime/i02 manage createsuperuser
```

Если CheckOnly показал другую БД/Python, используйте именно их (runtime — каталог БД) и тот же `--python-extra-site`, если настроен. `scripts/legacy/CREATE_PILOT_ADMIN.cmd` относится к `.runtime/pilot`: его пользователь не появится в MAIN. Нестандартный API-порт меняет адрес admin. Не создавайте пустую БД ради восстановления входа.

Другие порты:

```powershell
.venv\Scripts\python.exe -B tools/pilot.py --runtime .runtime/i02 --api-port 8001 --site-port 5174 --worker-port 8373 --enable-model run
```

Укажите этот API в «Сервер платформы» и войдите заново. Порт сайта сам не меняет сохранённый API. Два комплекта на одних портах не запускать.

## Проверки без модели

```powershell
npm --prefix integration/ai ci --ignore-scripts
npm --prefix integration/ai test
node integration/ai/check.mjs
node --test tests/document-pilot-frontend.test.cjs
.venv\Scripts\python.exe -B tools/pilot.py --runtime .runtime/verify prepare
.venv\Scripts\python.exe -B tools/pilot.py --runtime .runtime/verify manage test tutor progress documents courses
```

Runtime проверки отдельный: prepare создаёт секреты и синтетические данные, Django использует тестовую БД. Не подставляйте действующий runtime. check.mjs проверяет 20 SHA и схемы без модели. Для проверки на живой модели используйте синтетические `tools/demo-materials`; смысл объяснений проверяется отдельно от формата.

## Восстановление

БД, личные документы, secrets, логи и квитанции находятся в выбранном runtime и не входят в Git. Остановите свой MAIN через Ctrl+C; перед миграциями сделайте согласованную резервную копию БД и private-media. Старую БД поверх новой не копировать. Откат исходников и данных планируются отдельно.

После сбоя сохраняйте runtime/логи. Для живого worker: `tools/pilot.py --runtime <тот-же-каталог> --worker-port <тот-же-порт> model status`; retire/enable относятся только к своему экземпляру. Не останавливайте общий LM Studio, не снимайте lock по возрасту, не присваивайте чужой instance. Unknown POST автоматически не повторяется. Документная очередь сверяется с receipt; полное восстановление Python-оценки в Django пока не реализовано.

Демо-пароли не подходят для интернет-развёртывания. Исходный PostgreSQL-профиль settings.py и scripts/legacy/START-FULL.cmd не являются production-конфигурацией пилота.

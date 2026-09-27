# voice_lists

Telegram-бот голосовых и текстовых заметок по спискам. Работает как вебхук на Vercel: голос → Groq Whisper, текст/расшифровка → Groq chat (JSON-команды), списки хранятся в памяти процесса.

## Как работает

1. `/start` — короткое приветствие и кнопка **«Новая заметка»**.
2. Голосовое или текст — бот понимает действие: добавить, показать, новый список, удалить последнее.
3. Списки вроде «Входящие», «покупки» живут **в памяти** сервера (после перезапуска могут пропасть).

Отмена: `/cancel`.

## Сайт

Лендинг: https://voice-lists-ten.vercel.app

Кнопка ведёт на https://t.me/voice_lists_bot

## Вебхук

`https://voice-lists-ten.vercel.app/api/bot`

- **POST** — апдейты от Telegram.
- **GET** — регистрирует вебхук через `setWebhook` (токен из env).

```bash
curl https://voice-lists-ten.vercel.app/api/bot
```

## Переменные окружения (Vercel)

| Имя | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather |
| `GROQ_API_KEY` | ключ Groq (Whisper + chat) |
| `WEBHOOK_URL` | (опционально) публичный URL вебхука |

Ключи **не** кладутся в Git.

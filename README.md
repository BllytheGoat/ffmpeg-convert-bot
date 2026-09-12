# ffmpeg-convert-bot

Telegram bot that converts images/videos to up to 5 formats via FFmpeg,
with optional lossless compression, hosted on Vercel serverless.

## How it works
1. Send a video/image file (≤50MB) or a public URL to the bot
2. The bot shows 5 format options + a compression toggle
3. Pick your formats, toggle compress (ON = smaller file, minimal quality loss)
4. Bot converts via FFmpeg, uploads results to Storage.to, replies with links
5. Files auto-expire after 3 days

## Setup
1. Set environment variables (or rely on /root/.hermes/secret.env):
   - TELEGRAM_BOT_TOKEN
   - STORAGE_TO_TOKEN
   - WEBHOOK_HOST (e.g. https://ffmpeg-convert-bot.vercel.app)
2. Deploy to Vercel
3. Run `node webhook-setup.js` to register the webhook with Telegram

## Formats
- Images: PNG, JPEG, WEBP, GIF, AVIF
- Video: MP4, WEBM, MOV, MKV, AVI

## Notes
- Files >50MB: send a public URL instead of a direct upload
- 3-day expiry is built into Storage.to (no cron needed)

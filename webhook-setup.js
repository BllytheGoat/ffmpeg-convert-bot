// webhook-setup.js — run after deploying to Vercel:
//   node webhook-setup.js
// Registers the bot webhook with Telegram pointing at your Vercel URL.
const https = require('https');
const config = require('./src/config');

const webhookUrl = process.env.WEBHOOK_HOST
  ? process.env.WEBHOOK_HOST + '/'
  : config.WEBHOOK_HOST;
if (!webhookUrl) {
  console.error('Set WEBHOOK_HOST (e.g. https://ffmpeg-convert-bot.vercel.app) or the env var.');
  process.exit(1);
}

const token = config.TELEGRAM_BOT_TOKEN;
const url = `https://api.telegram.org/bot${token}/setWebhook`;
const body = JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'callback_query'] });

const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const j = JSON.parse(data);
    if (j.ok) console.log('Webhook registered:', j);
    else console.error('Failed:', j);
  });
});
req.write(body);
req.end();

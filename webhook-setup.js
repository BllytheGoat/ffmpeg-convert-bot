// webhook-setup.js — run after deploying to Vercel:
//   TELEGRAM_WEBHOOK_SECRET=*** node webhook-setup.js
// Registers the bot webhook with Telegram pointing at your Vercel URL, and
// sets a secret token so only Telegram can post to the webhook.
const https = require('https');
const config = require('./src/config');

const webhookUrl = process.env.WEBHOOK_HOST
  ? process.env.WEBHOOK_HOST + '/'
  : config.WEBHOOK_HOST;
if (!webhookUrl) {
  console.error('Set WEBHOOK_HOST (e.g. https://ffmpeg-convert-bot.vercel.app) or the env var.');
  process.exit(1);
}

const secret = config.TELEGRAM_WEBHOOK_SECRET || process.env.TELEGRAM_WEBHOOK_SECRET;
const token = config.TELEGRAM_BOT_TOKEN;
const url = `https://api.telegram.org/bot${token}/setWebhook`;
const bodyObj = { url: webhookUrl, allowed_updates: ['message', 'callback_query'] };
if (secret) bodyObj.secret_token = secret;
const body = JSON.stringify(bodyObj);

if (!secret) {
  console.warn('WARNING: TELEGRAM_WEBHOOK_SECRET not set — webhook will be unauthenticated. Set it and redeploy before going live.');
}

const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const j = JSON.parse(data);
    if (j.ok) console.log('Webhook registered:', JSON.stringify(j));
    else console.error('Failed:', j);
  });
});
req.write(body);
req.end();

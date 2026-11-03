// Helper: after you send any message to your bot, run `npm run telegram:chatid` to print your chat id.
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN first");
const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data: any = await res.json();
const chats = new Map<string, string>();
for (const u of data.result ?? []) {
  const c = u.message?.chat ?? u.channel_post?.chat;
  if (c) chats.set(String(c.id), c.title ?? c.username ?? c.first_name ?? "");
}
if (!chats.size) console.log("No messages found. Send your bot a message (e.g. 'hi') and run this again.");
for (const [id, name] of chats) console.log(`TELEGRAM_CHAT_ID=${id}   (${name})`);

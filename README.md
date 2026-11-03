# Sports Match Predictor

Every 30 minutes this bot:

1. Finds matches starting in about **15–100 minutes**: NBA, WNBA, top football (soccer) leagues, ATP/WTA tennis, Dota 2 and CS2 (college basketball optional).
2. Gets odds from **many bookmakers, including Pinnacle** (the sharpest one).
3. Works out the **fair chances** by removing Pinnacle's margin (or using the consensus of several bookmakers). With no odds, it falls back to a simple stats model: tennis world rankings, esports Elo, season records.
4. Sends **one Telegram digest** of everything starting soon.
5. Sends a **separate alert for each value bet**: a bookmaker paying more than the fair price. Alerts include injuries, news and (optionally) AI notes on what could make it a trap.
6. Logs everything and sends a **daily accuracy report** with the profit or loss of every value bet.

Runs for **$0** on GitHub Actions. The AI notes are optional and the only paid part (cents per month).

## Why it works this way

Beating bookmakers by predicting matches better than them is very hard. The free, simple models here can't do it. What *does* work for ordinary bettors is **line shopping against a sharp bookmaker**:

- Pinnacle takes big bets from professionals and moves its prices quickly, so its odds (with the margin removed) are the best free estimate of the true chances.
- Other bookmakers are slower. When one of them offers, say, 2.25 on a team whose fair price is 2.05, that bet is worth about +10% on average over many bets.

The stats model is only used when there are no odds, and the digest marks every number with its source.

## Example messages

```
⏱ Starting soon · 3 matches · 19:30–20:00 UTC

⚽ Champions League
20:00 Barcelona 72% · draw 15% · Aston Villa 13% P
20:00 Manchester United 44% · draw 25% · AS Roma 31% P 💎

🎾 Rolex Paris Masters
19:30 Casper Ruud 41% · Rafael Jodar 59% P

P = Pinnacle no-vig · C = bookmaker consensus · B = one bookmaker · M = stats model only. 💎 = value bet (details follow).
```

```
💎 Value bet: Manchester United @ 2.45 on Unibet
⚽ Manchester United vs AS Roma
🏆 Champions League
🕒 20:00 UTC (in 1h 24m)

📊 Fair chances (Pinnacle): Manchester United 44% · draw 25% · AS Roma 31%
   Stats model: Manchester United 41% · draw 27% · AS Roma 32%
➜ Fair price 2.27, offered 2.45: expected value +7.8%
💰 Best odds: Manchester United 2.45 (Unibet) | Draw 4.10 (Bet365) | AS Roma 3.30 (William Hill)

🔍 Key factors:
 • Manchester United: record 2-0-1, form WWDLW
 • AS Roma injuries: P. Dybala (Out)

Confidence: high · prices move, so check the current odds · match page
```

## Costs and limits

| Piece | Service | Cost |
|---|---|---|
| Scheduler | GitHub Actions | Free on a **public** repo. A private repo gets 2,000 min/month, and running every 30 min needs about 2,200–2,900. |
| Basketball, football, tennis schedules, injuries, rankings | ESPN public JSON | Free, no key |
| Odds from many bookmakers | [The Odds API](https://the-odds-api.com) | Free tier: 500 credits/month |
| Dota 2 / CS2 | [PandaScore](https://pandascore.co) | Free plan |
| Messages | Telegram bot | Free |
| AI notes on value bets (optional) | Claude API | Pay per use; well under a cent per alert on the default `claude-haiku-5-5` |

**The free odds quota is about 16 calls a day.** The bot spreads it over the month automatically: one call per sport only when that sport has new matches about to start. When the daily allowance is used up, the digest still goes out, just without odds. Busy days (e.g. Saturday football) may run out by evening. Fewer sports means more odds per sport. The Odds API's paid plan (about $30/month for 20,000 credits) removes the limit.

Esports have no odds source on the free plan, so Dota 2 / CS2 lines are stats-only (Elo computed from recent results).

## Setup (about 20 minutes, no server needed)

### 1. Create your Telegram bot
1. In Telegram, open **@BotFather**, send `/newbot`, and follow the steps. Copy the **token**.
2. Open your new bot and send it any message (e.g. "hi").
3. Get your chat id: run `TELEGRAM_BOT_TOKEN=your_token npm run telegram:chatid`, or open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and copy `"chat":{"id": ...}`.

### 2. Get free API keys
- **The Odds API** (needed for value bets): sign up at the-odds-api.com and copy the key from your email.
- **PandaScore** (needed for Dota 2 / CS2): sign up at pandascore.co and copy the token from your dashboard.

### 3. Put the code on GitHub
Create a new **public** repository and push this folder. (Secrets stay hidden in a public repo. The prediction log on the `bot-data` branch will be public.)

### 4. Add your secrets
In the repo: **Settings → Secrets and variables → Actions**.

**Secrets** tab → *New repository secret*:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `TELEGRAM_CHAT_ID` | from step 1 |
| `ODDS_API_KEY` | from The Odds API |
| `PANDASCORE_TOKEN` | optional (esports) |
| `ANTHROPIC_API_KEY` | optional (AI notes) |

**Variables** tab (all optional):

| Name | Default | Meaning |
|---|---|---|
| `SPORTS` | `nba,wnba,football,tennis,dota2,cs2` | which sports to cover (`basketball` = NCAA men; many games, uses lots of odds credits) |
| `LEAD_MIN_MINUTES` / `LEAD_MAX_MINUTES` | `15` / `100` | pick up matches starting between these many minutes from now |
| `MIN_EDGE_PCT` | `3` | value-bet alert threshold (expected value %) |
| `DIGEST` | `1` | `0` = only send value-bet alerts, no digest |
| `ODDS_REGIONS` | `eu` | bookmaker region(s) at The Odds API; `eu` includes Pinnacle. Each extra region costs 1 more credit per call |
| `LLM_MODEL` | `claude-haiku-5-5` | AI model for the value-bet notes |

### 5. Turn it on
Go to the **Actions** tab, enable workflows, open **Match predictions**, and click **Run workflow** to test. After that it runs every 30 minutes by itself. The first run creates the `bot-data` branch where it keeps its memory.

## Run on your own computer

```bash
npm install
npm run dry             # prints messages instead of sending them, saves nothing
npm start               # sends to Telegram
npm run results         # accuracy report
npm test
```
Pass settings as environment variables, e.g. `ODDS_API_KEY=... LEAD_MAX_MINUTES=600 npm run dry`, or put them in a `.env` file and use `node --env-file=.env`. Note: a dry run with an odds key still spends real odds credits.

## Project layout

```
src/
  main.ts              the pipeline (collect → odds → fair chances → digest + alerts → log)
  predict.ts           one match → prediction (no network)
  odds/fair.ts         margin removal, Pinnacle/consensus fair chances, value detection
  odds/budget.ts       spreads the free odds quota over the month
  sources/espn.ts      schedules, tennis rankings, injuries/news/H2H
  sources/esports.ts   Dota 2 / CS2 from PandaScore + Elo ratings
  sources/oddsapi.ts   odds from many bookmakers
  model/probability.ts fallback stats models
  agent/analyst.ts     optional Claude notes on value bets
  notify/telegram.ts   digest + alert formatting, sending
  results.ts           grading and the daily report
data/                  runtime state (on GitHub: the bot-data branch)
```

## About 1xBet

1xBet has no public API, its terms forbid scraping, and it blocks cloud servers like GitHub's. The Odds API's `eu` region may include 1xBet among its bookmakers; if it does, its prices are compared automatically like any other.

## Ideas for later
- Track closing-line value: compare each alert's price with Pinnacle's price at kickoff. That is the fastest honest test of whether the alerts are any good (costs extra odds credits).
- A second, short alert when a key player is ruled out after the digest went out.
- Better football ratings once a free Elo source is reachable again (ClubElo was down when this was built).
- Train a model on the prediction log once a few hundred matches are graded.

## Important
- **No system guarantees wins.** Even true +EV bets lose often; the profit shows only over hundreds of bets. Watch the daily report for weeks before risking real money.
- Bookmakers often limit accounts that keep beating their prices.
- Check that sports betting is legal where you live, and only bet what you can afford to lose.
- ESPN's endpoints are free but unofficial and can change without notice. If a sport stops showing up, check the logs in the Actions tab.

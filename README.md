# Sports Match Predictor

Every 2 hours this bot:

1. Finds matches starting in about **15–150 minutes**: NBA, WNBA, top football (soccer) leagues, ATP/WTA tennis, Dota 2 and CS2 (college basketball optional).
2. Gets odds from **many bookmakers, including Pinnacle** (the sharpest one).
3. Works out the **fair chances** by removing Pinnacle's margin (power method, which corrects the favourite–longshot bias) (or using the consensus of several bookmakers). With no odds, it falls back to a simple stats model: tennis world rankings, esports Elo, season records.
4. Sends **one Telegram digest** of everything starting soon. A 🔗 on a line opens that match at your bookmaker (1xBet by default, set by `BOOKMAKERS`) when the odds service provides the page.
5. Sends a **separate alert for each value bet**: a bookmaker paying more than the fair price, and **how much to stake**. Alerts include injuries, news and (optionally) AI notes on what could make it a trap.
6. Logs everything and sends a **daily accuracy report**: what the bets won or lost, how the last week and month went, which sports and bookmakers the money came from, and whether the bot itself is still healthy.

Runs for **$0** on GitHub Actions. The AI notes are optional and the only paid part (cents per month).

## Why it works this way

Beating bookmakers by predicting matches better than them is very hard. The free, simple models here can't do it. What *does* work for ordinary bettors is **line shopping against a sharp bookmaker**:

- Pinnacle takes big bets from professionals and moves its prices quickly, so its odds (with the margin removed) are the best free estimate of the true chances.
- Other bookmakers are slower. When one of them offers, say, 2.25 on a team whose fair price is 2.05, that bet is worth about +10% on average over many bets.

The stats model is only used when there are no odds, and the digest marks every number with its source.

### Why some "value" isn't value

An edge is easy to work out and easy to get wrong. A few checks throw the bad ones away.

A price nobody has moved for hours tells you nothing about now. Those odds still appear in the digest, but the bot won't call them value. The limit is 30 minutes (`MAX_ODDS_AGE_MINUTES`). Old sharp prices were the biggest source of edges that weren't really there.

When the fair price comes from several bookmakers instead of Pinnacle, the bookmaker offering the generous price is taken out of that group first. Leave it in and you are partly measuring its price against itself. If that leaves fewer than three bookmakers, the bot says nothing.

A group of bookmakers also has to clear a higher bar: 6% instead of 3% (`MIN_EDGE_CONSENSUS_PCT`). Taking the margin off a few soft bookmakers is a rough estimate, so a small edge against it is usually just noise.

Anything over 25% (`MAX_EDGE_PCT`) goes in the bin as well. An edge that big nearly always means the wrong match was matched up, or the line is dead.

## Example messages

```
⏱ Starting soon · 3 matches · Tue, Nov 3 · 3:30 AM–4:00 AM PHT

⚽ Champions League
4:00 AM Barcelona 72% · draw 15% · Aston Villa 13% P
4:00 AM Manchester United 44% · draw 25% · AS Roma 31% P 💎

🎾 Rolex Paris Masters
3:30 AM Casper Ruud 41% · Rafael Jodar 59% P

P = Pinnacle no-vig · C = bookmaker consensus · B = one bookmaker · M = stats model only. 💎 = value bet (details follow).
```

```
💎 Value bet: Manchester United @ 2.45 on Unibet
⚽ Manchester United vs AS Roma
🏆 Champions League
🕒 Tue, Nov 3 · 4:00 AM PHT (in 1h 24m)

📊 Fair chances (Pinnacle): Manchester United 44% · draw 25% · AS Roma 31%
   Stats model: Manchester United 41% · draw 27% · AS Roma 32%
➜ Fair price 2.27, offered 2.45: expected value +7.8%
💵 Stake: 1.42% of bankroll ≈ 14.20 (quarter Kelly, capped at 2%)
💰 Best odds: Manchester United 2.45 (Unibet) | Draw 4.10 (Bet365) | AS Roma 3.30 (William Hill)

🔍 Key factors:
 • Manchester United: record 2-0-1, form WWDLW
 • AS Roma injuries: P. Dybala (Out)

Confidence: high · price last moved 6m ago · prices move, so check the current odds · match page
```

The stake is a quarter of the Kelly stake, never more than 2% of your bankroll. It shows money as well as a percentage once you set `BANKROLL`.

```
📈 Accuracy report · 34 finished matches

How good were the win chances? (score: 0 = perfect, lower is better)
• Bookmaker odds, margin removed: 0.214
• Our own stats guess: 0.248
...
💎 Value bets: 11 finished. Betting 1 unit on each would have made +1.85 units (+16.8% of the money staked).

📅 Recently
• Last 7 days: 12 matches, 4 bets · +0.95 units (+23.8%)
• Last 30 days: 34 matches, 11 bets · +1.85 units (+16.8%)

🏪 By bookmaker
• 1xBet: 8 bets · +2.10 units (+26.3%)
• Unibet: 3 bets · -0.25 units (-8.3%)

🎯 Did we beat the sharp price? 8 of 11 bets, average +2.4% better than the later fair price.

🩺 Health (last 24h): 12 runs, 41 matches seen, 2 value bets.
• Odds coverage: 78% of new matches priced, 61% with a price worth betting against.
```

## Costs and limits

| Piece | Service | Cost |
|---|---|---|
| Scheduler | GitHub Actions | Free on a **public** repo. A private repo gets 2,000 min/month; running every 2 hours needs about 600–750. |
| Basketball, football, tennis schedules, injuries, rankings | ESPN public JSON | Free, no key |
| Odds from many bookmakers | [The Odds API](https://the-odds-api.com) | Free tier: 500 credits/month |
| Tennis and esports odds | [OddsPapi](https://oddspapi.io) | Free tier: 250 requests/month |
| Dota 2 / CS2 | [PandaScore](https://pandascore.co) | Free plan |
| Messages | Telegram bot | Free |
| AI notes on value bets (optional) | Claude API | Pay per use; well under a cent per alert on the default `claude-haiku-5-5` |

**The free odds quota is about 16 calls a day.** The bot spreads it over the month automatically: one call per sport only when that sport has new matches about to start. When the daily allowance is used up, the digest still goes out, just without odds. Busy days (e.g. Saturday football) may run out by evening. Fewer sports means more odds per sport. The Odds API's paid plan (about $30/month for 20,000 credits) removes the limit.

**OddsPapi fills the gaps** (tennis tour events and Dota 2 / CS2, which The Odds API doesn't price). It only runs when a tennis or esports match still has no price the bot can work with: no Pinnacle price, and fewer than three bookmakers. One soft bookmaker on its own is no help, because a bookmaker can never beat its own price. One bulk call per bookmaker covers up to 5 tournaments, and the bot asks for Pinnacle plus your bookmaker (`BOOKMAKERS`, default 1xBet), so a run costs about 2 requests, plus a few more once a week to refresh its tournament and name lists. The same daily budgeting applies (about 7 requests a day). Esports matches the bot can't price still show up with the Elo estimate, marked M.

**How the credits are shared out**
- Each service gets a daily share of what's left in the month (about 16 credits a day for The Odds API, 7 requests a day for OddsPapi).
- A quarter of the day's share may be spent before 06:00 UTC, 45% before 12:00, 75% before 18:00, so the afternoon and evening matches always have credits.
- The most important leagues are priced first (Champions League, Premier League, NBA, La Liga, Serie A, Bundesliga, Ligue 1, Europa League), then everything else.
- If a match can't be priced only because the share is used up, and another run can still see it, the bot holds it back and tries again next run instead of sending it without odds. Set `RUN_INTERVAL_MINUTES` if your timer isn't every 2 hours.
- Runs from your own computer spend the same free credits, so use `npm run dry` sparingly.

## How you know it's working

Nobody is watching this bot, so it has to speak up when it stops working.

Every run writes a line to `data/runs.jsonl`: how many matches it saw, how many of them got prices, how many got a price worth betting against, how many value bets went out, how many requests failed. The daily report ends with a summary of the last 24 hours taken from those lines.

If twelve runs in a row find no match at all (about a day), or a run can't reach anything, you get a short Telegram warning instead of silence. It won't repeat more than twice a day. Change the count with `WATCHDOG_RUNS`.

The report also tells you whether your bets beat the sharp price. That question is worth asking because profit needs hundreds of bets before it means anything, while "did we take a better price than Pinnacle ended up at" starts to mean something after a few dozen. Matches you already hold a bet on are added to odds calls the bot is making anyway, so these later prices cost no extra credits. They collect in `data/clv.jsonl`.

Bad settings get flagged too. An unknown sport in `SPORTS` is dropped with a warning instead of quietly leaving you with nothing to show, a number that isn't a number falls back to its default, and a pickup window too narrow for the run interval is pointed out.

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
| `ODDSPAPI_KEY` | optional (tennis and esports odds) |
| `ANTHROPIC_API_KEY` | optional (AI notes) |

**Variables** tab (all optional):

| Name | Default | Meaning |
|---|---|---|
| `SPORTS` | `nba,wnba,football,tennis,dota2,cs2` | which sports to cover (`basketball` = NCAA men; many games, uses lots of odds credits) |
| `LEAD_MIN_MINUTES` / `LEAD_MAX_MINUTES` | `15` / `150` | pick up matches starting between these many minutes from now (keep the gap comfortably over 120, the run interval; the bot warns if it's too narrow) |
| `MIN_EDGE_PCT` | `3` | value-bet alert threshold (expected value %) against Pinnacle |
| `MIN_EDGE_CONSENSUS_PCT` | `6` | the same threshold when the fair price comes from several bookmakers instead |
| `MAX_EDGE_PCT` | `25` | an edge bigger than this is treated as a mistake in the data, not a bet |
| `MAX_ODDS_AGE_MINUTES` | `30` | ignore prices older than this when looking for value; they still appear in the digest |
| `KELLY_FRACTION` | `0.25` | how much of the full Kelly stake to suggest. `0` leaves the stake out of the alert |
| `MAX_STAKE_PCT` | `2` | never advise staking more than this percentage of the bankroll |
| `BANKROLL` | – | set it to also see stakes in money, not just percent |
| `TIMEZONE` | `Asia/Manila` | timezone for the times in messages (12-hour clock), any IANA name such as `America/New_York` |
| `DIGEST` | `1` | `0` = only send value-bet alerts, no digest |
| `BOOKMAKERS` | all | bookmakers you can bet with, e.g. `1xbet,bet365`. Value alerts only use their prices |
| `ESPORTS_TIERS` | `s,a,b` | esports tournament tiers to include (`c`, `d`, `unranked` add many small matches) |
| `ODDS_REGIONS` | `eu` | bookmaker region(s) at The Odds API; `eu` includes Pinnacle. Each extra region costs 1 more credit per call |
| `LLM_MODEL` | `claude-haiku-5-5` | AI model for the value-bet notes |
| `TRACK_CLV` | `1` | collect later sharp prices for bets already sent, to see if they beat the close. Costs nothing. `0` turns it off |
| `WATCHDOG_RUNS` | `12` | warn on Telegram after this many runs in a row that found nothing |
| `KEEP_DAYS` | `120` | predictions older than this move to a monthly archive file; their totals are kept |
| `FETCH_CONCURRENCY` | `5` | how many schedule requests to make at once |

### 5. Turn it on
Go to the **Actions** tab, enable workflows, open **Match predictions**, and click **Run workflow** to test. After that it runs every 2 hours by itself. The first run creates the `bot-data` branch where it keeps its memory.

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
  odds/fair.ts         margin removal, Pinnacle/consensus fair chances, price age, value detection
  odds/stake.ts        how much to bet (fractional Kelly, capped)
  odds/budget.ts       spreads the free odds quota over the month
  sources/espn.ts      schedules, tennis rankings, injuries/news/H2H
  sources/esports.ts   Dota 2 / CS2 from PandaScore + Elo ratings
  sources/oddspapi.ts  tennis + esports odds (Pinnacle, 1xBet) from OddsPapi, request-budgeted
  sources/oddsapi.ts   odds from many bookmakers
  model/probability.ts fallback stats models
  agent/analyst.ts     optional Claude notes on value bets
  notify/telegram.ts   digest + alert formatting, sending
  results.ts           grading, log rotation and the daily report
  report.ts            the report text (pure)
  clv.ts               later sharp prices for bets already sent
  health.ts            run records and the watchdog
  archive.ts           retiring old predictions while keeping their totals
  config.ts            settings, validated at startup
data/                  runtime state (on GitHub: the bot-data branch)
  sent.json            matches already sent (forgotten after 4 days)
  predictions.jsonl    every prediction, for grading
  results.jsonl        how each one turned out
  runs.jsonl           one line per run, for health and the watchdog
  clv.jsonl            later sharp prices for bets already sent
  totals.json          numbers for predictions archived out of the log
  archive/             the archived predictions themselves
```

Tests live in `test/` and run on every push (`.github/workflows/ci.yml`): `npm test` (unit, no network — every external service is faked) and `npm run typecheck`.

## About 1xBet

1xBet has no public API, its terms forbid scraping, and it blocks cloud servers like GitHub's. The Odds API's `eu` region may include 1xBet among its bookmakers; if it does, its prices are compared automatically like any other.

## Ideas for later
- Read the sharp price closer to kickoff. The free one rides along with calls the bot already makes, so it can be up to two hours early, and lines keep moving after that.
- A second, short alert when a key player is ruled out after the digest went out.
- Better football ratings once a free Elo source is reachable again (ClubElo was down when this was built).
- Train a model on the prediction log once a few hundred matches are graded.

## Important
- **No system guarantees wins.** Even true +EV bets lose often; the profit shows only over hundreds of bets. Watch the daily report for weeks before risking real money.
- Bookmakers often limit accounts that keep beating their prices.
- Check that sports betting is legal where you live, and only bet what you can afford to lose.
- ESPN's endpoints are free but unofficial and can change without notice. If a sport stops showing up, check the logs in the Actions tab.

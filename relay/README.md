# Orcha relay

A small Cloudflare Worker that lets you give someone Orcha with **your** Claude and Azure GPT-6 credits, capped at the amounts you choose. Your real provider keys stay in the relay and never reach their computer. They get their own token, and each request is metered against their budget.

```
Guest's Orcha ──(guest token)──▶ relay ──(your key)──▶ Anthropic / Azure OpenAI
                                   │
                                   └─ ledger: budgets, spend, invites (SQLite Durable Object)
```

- **Budgets per provider pool.** There are three pools: Claude, GPT-6 Sol and GPT-6 Astra. Each is a one-time amount that you can top up. When a pool reaches $0, new requests to it are refused with a clear message. A reply that's already streaming is allowed to finish.
- **Accurate money.** Cost is computed from the provider's own usage report on every reply, times list price:
  - input, cache reads, 5-minute and 1-hour cache writes, and output
  - reasoning tokens
  - long-context rates, fast mode, US-only inference, and web-search fees

  Prices live in [`src/pricing.ts`](src/pricing.ts), which is the only file to edit when a price changes. A reply cut short (Esc in the terminal) is billed exact input plus an estimate of the output that had already streamed.
- **Stays on the free plan.** Workers Free allows 10 ms of CPU per request. The relay streams bytes straight through and only parses the provider's usage events. Metering an unusually long ~1.2 MB reply measures about 3 ms (`npm test` checks this). Budgets live in one SQLite Durable Object, written pre-aggregated so frequent balance checks stay within the free row limits.

## One-time setup

**1. Provider keys, isolated for the relay**

- **Anthropic.** In the [Claude Console](https://platform.claude.com), create a workspace (e.g. `orcha-guests`). Set its spend limit to the guest's Claude budget as a backstop, then create an API key in that workspace.
- **Azure.** Create a separate Azure OpenAI / Foundry resource for guests. Deploy **Global Standard** deployments named exactly `gpt-6-sol` and `gpt-6-astra`; the relay sends the model name as the deployment name. Copy the resource endpoint (`https://<resource>.openai.azure.com`) and a key.

**2. Deploy** (from this folder):

```bash
npm install
npx wrangler login     # once; opens the browser
npm run setup          # deploys, creates the admin token, saves ~/.orcha/relay-admin.json
```

**3. Add the provider keys from your clipboard.** Copy each value, then run its line. The value goes straight into Cloudflare and is never printed or saved locally.

```bash
npm run secret ANTHROPIC_API_KEY
npm run secret AZURE_API_KEY
npm run secret AZURE_ENDPOINT
```

After that, Orcha's **Settings → Guests** finds the relay by itself. That panel is where you invite someone, watch their spend, top up, or turn access off.

## Tests

```bash
npm test          # metering + pricing unit tests, including the CPU budget check
npm run test:e2e  # the real Worker under `wrangler dev` against fake providers, $0
```

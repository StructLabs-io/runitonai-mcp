# Run It on AI — the companion server, in full

This repository is the complete source code of the server that powers the
*Run It on AI* reading companion at `mcp.runitonai.com`. If you bought the
book and connected your AI to it, this is everything that runs on our side.

We publish it so you do not have to take our word for anything. The server
is a few hundred lines of TypeScript. You (or your AI — paste any file into
it and ask) can read exactly what it does and, just as importantly, what it
cannot do.

## The short version

**What reaches our server when you use the companion:**

- The name of the tool your AI called (for example "fetch chapter 3").
- The chapter or exercise it asked for.
- Your access code — the license key printed on your Gumroad receipt.

**What never reaches us, because there is no code here that could receive,
store, or forward it:**

- Your conversations with your AI.
- Your files, documents, or anything on your machine.
- Your name.
- Your email. Search this repository for an email field: there is none.
  No tool, no endpoint, no code path accepts one.
- The picture your AI forms of you while you work. That stays inside your
  AI, on your side.

**Who talks to whom:** when you add the companion as a Claude connector,
your machine never contacts our server directly — Anthropic's cloud brokers
the connection. On ChatGPT, OpenAI's cloud does. We see tool calls, not you.

## How access works

Your credential is the **license key** on your Gumroad receipt (a code like
`XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX`). It identifies a purchase, not a
person. The server checks it against Gumroad, caches a hash of it for a day,
and rate-limits it. Refunded or disabled keys stop working. See
[`src/license.ts`](src/license.ts) — the whole mechanism is one file.

Only chapter text needs the key. The companion's operating instructions
(`activate`) and every Implementation Block — the book's working exercises —
are served without any credential at all; the exercises are also published
right here in [`implementation-blocks/`](implementation-blocks/).

## Connect it

**Claude (web or desktop) — the easy path.**
Settings -> Connectors -> Add custom connector, then paste:

```
https://mcp.runitonai.com/mcp
```

Start a chat with: `Activate Run It on AI — my access code is <your license key>`.

**ChatGPT.** Use the "Run It on AI Companion" GPT (link in the book), or
build your own: create a Custom GPT and import
`https://mcp.runitonai.com/openapi.yaml` as an Action.

**Claude Code (terminal users).**

```sh
claude mcp add --transport http runitonai-book https://mcp.runitonai.com/mcp
```

**Codex.** In `~/.codex/config.toml`:

```toml
[mcp_servers.runitonai_book]
url = "https://mcp.runitonai.com/mcp"
```

## What is in this repo

| Path | What it is |
|---|---|
| `src/worker.ts` | The Cloudflare Worker: routing, transports, the Gumroad sync endpoint |
| `src/license.ts` | License-key verification and caching (the access gate) |
| `src/auth.ts` | Verification of legacy bearer tokens (nothing mints new ones) |
| `src/rate_limit.ts` | Per-key rate limiting |
| `src/mcp/` | MCP protocol plumbing (tool catalog, dispatch, transports) |
| `src/tools/` | The tools your AI can call |
| `openapi-v1.yaml` | The same surface described for ChatGPT Actions |
| `implementation-blocks/` | Every Implementation Block from the book, as readable markdown |

Two data files ship as placeholders: `src/data/chapters.json` (the book's
chapter text) and `src/data/skill.json` (the companion's operating
instructions). Both are generated from the book manuscript at deploy time.
The book's prose is the product, so it is not in the public repo — but the
code that serves it is all here, and the Implementation Blocks (the working
exercises) are published in full in `implementation-blocks/`.

Note for contributors: everything in this repo is generated from the
private manuscript repo by a sync script, and a pre-commit hook there
re-syncs it on every relevant change. The Implementation Blocks live in the
book's manuscript; the copies here are build artifacts — never edit them
here, they will be overwritten.

## Run it yourself

```sh
npm install
npm run typecheck
npm run dev        # local server on localhost:8787
```

`wrangler.toml` ships with placeholder KV namespace ids; point them at your
own Cloudflare account if you want to self-host the shell.

## License

MIT — see [LICENSE](LICENSE). The book itself (chapters, companion
instructions) remains copyrighted content of StructLabs.io Pte Ltd and is
not part of this repository.

# 🔧 WP Plugin Forge

A web app that designs and generates **production-grade WordPress plugins** with a
**multi-model AI pipeline** (via [OpenRouter](https://openrouter.ai)), runs
**deterministic safety checks** to avoid critical errors, **learns from past
mistakes** with a semantic memory, and lets you **download a ready-to-install ZIP**.

Built with **Next.js 15**, **Postgres 18 + pgvector**, and **Drizzle ORM**.
Designed to deploy on **Coolify**.

---

## ✨ What it does

A three-model pipeline, each role configurable in the UI:

| Role | Default model | Job |
| --- | --- | --- |
| 🧠 **Architect** | `anthropic/claude-opus-4.1` | Designs the full plugin: files, hooks, data model, security plan — as a structured manifest you approve/edit. |
| ⌨️ **Coder** | `anthropic/claude-sonnet-4.5` | Writes each file to WordPress coding standards. |
| 🔍 **Reviewer** | `anthropic/claude-opus-4.1` | Adversarially reviews each file for security holes and fatal errors. |

**Interactive checkpoint flow:** the architect proposes → *you approve or request
changes* → the coder writes files → the reviewer + deterministic validators check
them → an **autofix loop** rewrites files that have critical/high issues → you
download the ZIP.

### Avoiding critical errors (not just the LLM)
Every generated file passes through deterministic checks that catch the most common
ways a plugin breaks a site:
- **`php -l`** real syntax linting (PHP CLI ships in the Docker image) — stops the
  white-screen-of-death from parse errors.
- **ABSPATH** direct-access guard, valid **plugin header**, no trailing `?>`.
- Heuristics for **SQL injection** (`$wpdb` without `prepare()`), **XSS**
  (unescaped output), **unsanitized superglobals**, dangerous calls (`eval`, …),
  and **text-domain** consistency.

Critical findings block the plugin from being marked *ready* and feed the autofix loop.

### Memory that learns
Every fixed mistake becomes a **cross-plugin lesson**; architectures become reusable
**patterns**. On the next plugin, the most relevant memories are recalled and injected
into the prompts so the pipeline doesn't repeat past errors.
- **Semantic** recall via **pgvector** when an embeddings provider is configured.
- Transparent **Postgres full-text** fallback when it isn't — the app works with only
  an OpenRouter key.

Multi-user: each account has its own plugins and its own memory.

---

## 🚀 Deploy on Coolify

You need: a Coolify instance, an **OpenRouter API key**, and (optionally) an
embeddings key for semantic memory.

### Option A — Docker Compose (one resource)
1. In Coolify: **+ New Resource → Docker Compose**, point it at this repo (or paste
   `docker-compose.yml`).
2. Set environment variables (see below). At minimum: `AUTH_SECRET`,
   `OPENROUTER_API_KEY`, and the `POSTGRES_*` credentials.
3. Deploy. The bundled `pgvector/pgvector:pg18` database starts, the app waits for it
   to be healthy, runs migrations automatically, and boots.

### Option B — Separate App + Managed Database
1. **+ New Resource → Database → PostgreSQL** (choose **18**). Coolify's image
   includes pgvector. Note the credentials.
2. **+ New Resource → Application** from this repo. Coolify detects the `Dockerfile`.
3. Set `DATABASE_URL` to point at the database resource by its **service name**, e.g.
   `postgresql://USER:PASS@my-postgres-db:5432/wpforge`, plus the other env vars.
4. Deploy. Migrations run on container start (`docker-entrypoint.sh`).

> The app listens on port **3000**. Point your Coolify domain/proxy at it.

### Required environment variables
See [`.env.example`](./.env.example) for the full list. Essentials:

```bash
DATABASE_URL=postgresql://user:pass@db:5432/wpforge   # Postgres 18 + pgvector
AUTH_SECRET=<openssl rand -base64 48>                 # session signing secret
OPENROUTER_API_KEY=sk-or-v1-...                       # required

# Optional: semantic memory (else full-text fallback)
EMBEDDINGS_API_KEY=sk-...
EMBEDDINGS_BASE_URL=https://api.openai.com/v1
EMBEDDINGS_MODEL=text-embedding-3-small
EMBEDDINGS_DIMENSIONS=1536

# Optional: default models (also editable per-user in Settings)
DEFAULT_ARCHITECT_MODEL=anthropic/claude-opus-4.1
DEFAULT_CODER_MODEL=anthropic/claude-sonnet-4.5
DEFAULT_REVIEWER_MODEL=anthropic/claude-opus-4.1

ALLOW_REGISTRATION=true   # set false to lock sign-ups after the first (admin) user
```

The **first user to register becomes the admin**. Set `ALLOW_REGISTRATION=false`
afterwards to close registration.

> **Embedding dimensions:** the `embedding` column is `vector(1536)` to match
> `text-embedding-3-small`. If you switch to a model with a different dimension,
> update the schema and re-run migrations.

---

## 🧑‍💻 Local development

```bash
# 1. Start Postgres 18 + pgvector
docker run -d --name wpforge-db -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wpforge \
  pgvector/pgvector:pg18

# 2. Configure env
cp .env.example .env   # then fill in OPENROUTER_API_KEY + AUTH_SECRET

# 3. Install, migrate, run
npm install
npm run db:migrate     # creates the pgvector extension + tables
npm run dev            # http://localhost:3000
```

Useful scripts: `npm run build`, `npm run typecheck`, `npm run db:generate`
(regenerate SQL after editing `src/db/schema.ts`), `npm run db:studio`.

---

## 🏗️ Architecture

```
Browser ── Next.js (App Router) ──┬─ /api/auth/*        cookie+JWT auth (multi-user)
                                  ├─ /api/plugins/*     CRUD, architect, generate (SSE), zip
                                  ├─ /api/memory/*      semantic/lexical memory
                                  ├─ /api/models        live OpenRouter model list
                                  └─ /api/settings      per-user model + key config
                                          │
                    ┌─────────────────────┼─────────────────────┐
              Architect model        Coder model           Reviewer model   (OpenRouter)
                    │                     │                     │
                    └── structured ──> file-by-file ──> review + php -l + heuristics
                        manifest          generation        + autofix loop
                                          │
                              Postgres 18 + pgvector
                        (users, plugins, files, findings,
                         conversation, memory embeddings)
```

Key source paths:
- `src/lib/pipeline/prompts.ts` — the WordPress-expert system prompts.
- `src/lib/pipeline/orchestrator.ts` — the architect→code→review→fix→learn loop.
- `src/lib/pipeline/validate.ts` — deterministic safety checks (`php -l`, security).
- `src/lib/memory.ts` — pgvector + full-text memory store/retrieve.
- `src/db/schema.ts` — Drizzle schema.

---

## 🔒 Security notes
- Passwords are hashed with bcrypt; sessions are signed JWTs in an httpOnly cookie.
- Per-user OpenRouter keys are stored in the DB and override the server key.
- Generated plugin code is **AI-assisted, not a guarantee** — always review the
  Issues tab and test on a staging site before production.

## License
MIT

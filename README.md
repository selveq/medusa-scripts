# @selveq/medusa-scripts (`lma`)

Local dev CLI for Medusa: installs a new project, then runs it with dockerized
Postgres/Redis/nginx, port allocation, db import/dump, admin seeding and a
Cloudflare tunnel. Config per project in `lma.js` (`lma.cjs` in ESM projects),
scaffolded by `lma init`.

Node ≥ 20 and Docker; `cloudflared` for tunnels. No runtime dependencies.

## New project

```bash
mkdir my-shop && cd my-shop
npx @selveq/medusa-scripts init
```

`init` starts Docker if you agree, asks what to call the backend and the store, and
does the rest:

1. Installs the latest Medusa with `create-medusa-app`, with Medusa's demo data.
2. Renames the apps to `apps/<backend>` and `apps/<store>`, with their packages and scripts.
3. Finds free ports and wires the apps to them. No port goes in `lma.js`, and it never asks for one.
4. Writes the env files with generated secrets, a workspace file and a git repo with nothing committed.
5. Migrates, creates the admin user, starts both apps and prints where they are.

`--backend <name> --store <name>` answers without asking, and `--yes` starts Docker
without asking. A folder only counts as empty if it holds nothing beyond `.git`,
`.claude` and editor files. Installing needs the Node version Medusa asks for, and a path
with none of `( ) [ ] { } * ? !` in it, since Medusa finds no migrations under one that has.

The install runs aside in `.lma-install/`, so a failure there leaves nothing else and
`init` can simply run again. A failure after the project has moved in says which two
commands finish the job.

## Existing project

```bash
npm i -D @selveq/medusa-scripts
npx lma init
npm run lma start
```

Install first: the bare `lma` name on npm is an unrelated package. Here `init` only
writes the config and the npm alias.

## Apps

A project has one backend and any number of stores, all under `apps`. The key `backend` is
the backend, whatever its folder is called, and every other key is a store, in config
order. Those names are what `logs`, `restart` and `tunnel` take, and a folder defaults to
`apps/<name>`.

```js
apps: {
    backend: {},
    storefront: {},
    webfront: {},
},
```

`dir` names a folder that is called something else or lives elsewhere,
`backend: { dir: 'apps/api' }`. `port` on any app is an override, see Ports. The nginx
proxy sends `/` to `proxy.store`, or to the first store when it is not set; every store
also answers on its own port, and every store's origin is in `STORE_CORS`.

To add a store, put its folder under `apps/` and add its key: lma starts it with
`npm run dev`, hands it the backend url and the publishable key, and `start` prints where
it is. A backend that was already running keeps the CORS list it started with, so
`lma restart backend` lets the new store in. To rename a store, rename its key and move
its folder, or set `dir`. The workspace
package name and the root scripts are the project's own. A config from 0.3.0 works as it
is, unless it marked another key with `role: 'backend'`: that key becomes `backend`, with
its folder in `dir`.

## Ports

No port is chosen in advance. Each service takes the first free port in its band, and the
apps are wired to whatever was found: lma exports the connection values on every start
and rewrites the keys it owns in the env files, `PORT`, `DATABASE_URL` and `REDIS_URL` in
the backend `.env` and `NEXT_PUBLIC_MEDUSA_BACKEND_URL` in each store's `.env.local`, so
a build outside lma sees the right ports too.

| part | band |
| --- | --- |
| backend | 9000 to 9999 |
| stores, in config order | 8000 to 8999 |
| proxy | 80 to 180 |
| Postgres | 5432 to 5532 |
| Redis | 6379 to 6479 |

The map is pinned in the state folder, so a stack keeps its ports between restarts and
across a clean install, and every other lma project on this machine keeps away from them,
whether that stack is up or not: projects never trade ports. `lma ports` shows the map,
and `lma ports --reset` lets it go once the stack is stopped. A project you deleted holds
its ports until its state folder goes. A `port` in `lma.js` (`apps.<name>.port`, `services.postgres.port`,
`services.redis.port`, `proxy.port`) is where that search starts instead, and `start` says
when it could not be honoured.

## Commands

| command | does |
| --- | --- |
| `init` | new project in an empty folder, or the config in an existing one |
| `start` / `stop` / `restart` | infra + dev servers · stop keeps volumes |
| `restart <app>` | that dev server only, docker untouched |
| `status [--json]` | container and app state; exits non zero when something expected is down |
| `logs [app]` | follow a log |
| `logs <app> --errors --since-restart` | print and return; either flag or both |
| `run -- <command>` | run it with `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` and `DATABASE_URL`, kept awake |
| `destroy` | delete containers and volumes (confirm) |
| `ports [--reset] [--json]` | show or reallocate the port map |
| `import-db <f>` | drop, recreate, import .sql/.sql.gz/pg_dump (confirm) |
| `dump-db [path]` / `reset-db` | dump to the state folder or a path of yours / recreate empty (confirm) |
| `psql` / `redis` | shells into the containers |
| `migrate` | containers up, `medusa db:migrate`, then seed the admin |
| `seed-admin` / `admin` | create the configured admin / print its credentials |
| `show-env` | env lines for the backend `.env` |
| `tunnel setup/start/quick/stop/restart/status/logs` | Cloudflare tunnel |

`-n`/`--dry-run` prints the plan; it starts, stops and deletes nothing. `-y`/`--yes` answers
the confirmation and is required off a tty. One mutating command per project at a time.
`start`, `restart` and `init` exit non zero when an app did not come up.

## State

```text
~/.local-medusa-app/<folder>-<id>/       secrets.env, ports.json, dumps/, logs/, run/, tunnel/ (0700)
```

State stays out of the project because the admin's dev server hands out almost any file
inside the project to whoever reaches the backend, on your network or through a tunnel. It
refuses only `.env` names, certificates, `.git` and everything outside the project. A
`.local-medusa-app/` from an older lma, and the logs and port map it kept in
`node_modules`, move here by themselves the first time a newer lma runs.

The id comes from the folder's path, as the Docker volumes' does, so a moved or renamed
project starts fresh, and a deleted one leaves its state here until you remove it. Tunnel
credentials live in `~/.config/local-medusa-app/tunnels/`.

## What lma sets for the backend

Exported, so they win over the app's `.env`, since dotenv does not override an export:

- `PORT`, `DATABASE_URL`, `REDIS_URL`: this stack's, whatever the `.env` says.
- `__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS`: Vite answers 403 to any `Host` it was not told about. From `proxy.domain`, `tunnel.hostnames`, `proxy.allowedHosts`.
- `STORE_CORS` / `ADMIN_CORS` / `AUTH_CORS`: additive, the backend `.env` is read and its origins come first.
- `JWT_SECRET`, `COOKIE_SECRET`: generated ones, only when the backend has no `.env`.

Set at `lma start`, so `lma tunnel start` needs no restart. Each store gets `PORT`, `MEDUSA_BACKEND_URL` and `NEXT_PUBLIC_MEDUSA_BACKEND_URL` the same way, and the publishable key unless its `.env` or `.env.local` sets one.

## Tunnels

`start` and `quick` publish local ports on the public internet; the backend origin carries `/app`, `/auth`, every store route and the project's source files, which the admin's dev server serves. Development data only.

- `setup`/`start` ask for any missing hostname and save it to `lma.js`. Public domains only: `localhost` and bare addresses are refused.
- Every publication prints its routes and needs `expose` typed (or `--yes`). The acceptance records hostname and port, so either changing asks again.
- Publishing the backend is refused when `JWT_SECRET` or `COOKIE_SECRET` in its `.env` is missing or a public default, since anyone could then forge an admin login, when the admin password is guessable, and when `admin.password` sits in `lma.js`, a file the dev server serves (`LMA_TUNNEL_ALLOW_WEAK_ADMIN=1` overrides). lma cannot check an admin account it did not create.
- `start` probes the running backend for Host and CORS acceptance.
- `stop` finds tunnels by pid, config path, metrics port and UUID. `lma stop` and `lma destroy` take this folder's tunnel down too, and `lma status` says while something is published. Another checkout under the same tunnel name is the same Cloudflare tunnel: `lma tunnel stop` clears that one as well.
- `quick` needs no hostname or account, but its URL arrives after the dev server starts, so the admin cannot work over one.

Universal SSL covers one subdomain level: `app.example.com` works,
`api.app.example.com` gets a TLS handshake failure.

## Notes

- Postgres, Redis and nginx bind to `127.0.0.1`. The Medusa and Next dev servers listen on every interface, as they do by default and as the proxy needs on Linux, so someone on your network can reach them on their own ports.
- nginx routes `/app`, `/admin`, `/auth`, `/store`, `/hooks`, `/health` to the backend, the rest to the store.
- `start` warns when `JWT_SECRET` or `COOKIE_SECRET` in the backend `.env` is missing or a public default.
- `migrate` and `seed-admin` refuse when a `DATABASE_URL` exported in the shell points anywhere but this stack's Postgres, since lma's own would override it. `start` warns about it and seeds nothing.
- Only `start`, `restart` and `migrate` can move a port or rewrite an env file; reading commands and dry runs leave the map alone.
- A recorded pid is checked against the process start time before being signalled.
- `start` waits for a dev server that is restarting instead of launching a second one.
- `stop` waits up to 10 s for each dev server and its children to exit, then kills what is left.
- `start` on a database with no tables starts no apps and says to run `lma migrate`.
- Dev servers run in their own session, so closing the terminal leaves them running; `lma stop` ends them.
- `run` keeps the command's exit code, including after ctrl C or SIGTERM, and writes its own notes to stderr. It empties `PORT`, so Medusa's test runner picks a free port even with the stack up. `caffeinate` cannot stop a closed lid, so `run` reads `pmset -g log` afterwards and reports any sleep. It warns at the start on battery.
- `logs --since-restart` begins at the last time lma started the app or the app restarted itself. `--errors` is a pattern match on error lines, 5xx responses and their stacks, so treat it as a filter and not a verdict.
- `migrate` off a terminal passes `--execute-safe-links` and, where Medusa has it, `--execute-safe-search`, so it cannot hang on a prompt or delete anything.
- Infra images are pinned by tag and digest in `lib/images.js`; `:latest` warns.
- `LMA_PG_PORT`, `LMA_REDIS_PORT` and `LMA_HTTP_PORT`, the database login, the images and the admin login can be overridden with `LMA_*` variables for one command; app ports cannot. CORS and the allowed hosts are worked out from the config and do not follow them.

## Development

```bash
npm test
```

The real scripts against stand-in `docker`, `cloudflared`, `npm`, `npx`, `pmset` and `caffeinate` on `PATH`: no daemon, no network, and `python3` for the tests that need a terminal. CI runs them on Node 20, 22 and 24, plus shellcheck, one packed tarball that boots the real stack, and one real `lma init` in a folder with a space in its name.

## License

Copyright (c) 2026 Selveq. [MIT](./LICENSE).

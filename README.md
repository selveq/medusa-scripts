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
3. Picks free ports and saves them in `lma.js`. It never asks for one.
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

A project has one backend and at most one store, and each is called whatever `lma.js`
calls it. Those names are what `logs` and `restart` take.

```js
apps: {
    api: { role: 'backend', port: 9100 },
    frontend: { port: 8100 },
},
```

`dir` defaults to `apps/<name>`. A key called `backend` needs no `role`, so older configs
work unchanged, including one that lists more apps beside `storefront`: those keep their
port and can be published, but lma starts only the two. The store answers `/` on the nginx proxy.

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
~/.local-medusa-app/<folder>-<id>/       secrets.env, dumps/, logs/, run/, tunnel/ (0700)
node_modules/.local-medusa-app-cache/    ports.json
```

State stays out of the project because the admin's dev server hands out almost any file
inside the project to whoever reaches the backend, on your network or through a tunnel. It
refuses only `.env` names, certificates, `.git` and everything outside the project. A
`.local-medusa-app/` from an older lma, and the logs it kept in `node_modules`, move here by
themselves the first time 0.3.0 runs.

The id comes from the folder's path, as the Docker volumes' does, so a moved or renamed
project starts fresh, and a deleted one leaves its state here until you remove it.
`rm -rf node_modules` costs a port map, never a password or a dump. Tunnel credentials
live in `~/.config/local-medusa-app/tunnels/`.

## What lma sets for the backend

Exported, so they win over the app's `.env`, since dotenv does not override an export:

- `__MEDUSA_ADMIN_ADDITIONAL_ALLOWED_HOSTS`: Vite answers 403 to any `Host` it was not told about. From `proxy.domain`, `tunnel.hostnames`, `proxy.allowedHosts`.
- `STORE_CORS` / `ADMIN_CORS` / `AUTH_CORS`: additive, the backend `.env` is read and its origins come first.

Set at `lma start`, so `lma tunnel start` needs no restart. The database, Redis and secrets are injected only when the backend has no `.env`. The store gets its backend url and publishable key unless its `.env` or `.env.local` sets them.

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
- `migrate` and `seed-admin` refuse when an exported `DATABASE_URL` or the backend `.env` points anywhere but this stack's Postgres. `start` warns about it and seeds nothing there.
- Ports allocate to the closest free one and stay pinned until `--reset`, which needs the stack stopped. Only `start`, `restart` and `migrate` can move one, and they say when one is not the preferred port. A port edited in the config replaces the pin.
- A recorded pid is checked against the process start time before being signalled.
- `start` waits for a dev server that is restarting instead of launching a second one.
- `stop` waits up to 10 s for each dev server and its children to exit, then kills what is left.
- `start` on a database with no tables starts no apps and says to run `lma migrate`.
- Dev servers run in their own session, so closing the terminal leaves them running; `lma stop` ends them.
- `run` keeps the command's exit code, including after ctrl C or SIGTERM, and writes its own notes to stderr. It empties `PORT`, so Medusa's test runner picks a free port even with the stack up. `caffeinate` cannot stop a closed lid, so `run` reads `pmset -g log` afterwards and reports any sleep. It warns at the start on battery.
- `logs --since-restart` begins at the last time lma started the app or the app restarted itself. `--errors` is a pattern match on error lines, 5xx responses and their stacks, so treat it as a filter and not a verdict.
- `migrate` off a terminal passes `--execute-safe-links` and, where Medusa has it, `--execute-safe-search`, so it cannot hang on a prompt or delete anything.
- Infra images are pinned by tag and digest in `lib/images.js`; `:latest` warns.
- `LMA_*` variables override the ports, database login, images and admin login for one command. CORS and the allowed hosts are worked out from the config and do not follow them.

## Development

```bash
npm test
```

The real scripts against stand-in `docker`, `cloudflared`, `npm`, `npx`, `pmset` and `caffeinate` on `PATH`: no daemon, no network, and `python3` for the tests that need a terminal. CI runs them on Node 20, 22 and 24, plus shellcheck, one packed tarball that boots the real stack, and one real `lma init` in a folder with a space in its name.

## License

Copyright (c) 2026 Selveq. [MIT](./LICENSE).

# Changelog

## 0.3.0

- `lma init` in an empty folder asks about Docker and the names of the backend and the store, installs the latest Medusa with its own installer, assigns ports and starts it.
- Apps can have any name: mark the backend with `role: 'backend'`. Older configs work unchanged.
- `lma restart <app>` restarts one dev server and leaves Docker alone. It used to ignore the name and restart everything.
- `lma run -- <command>` runs a command with this stack's `DB_*` and `DATABASE_URL`, keeps the Mac awake and reports any sleep.
- `lma logs <app> --errors --since-restart` prints and returns.
- `--json` on `status` and `ports`. `status` now exits non zero when something expected is down.
- Dev servers survive the terminal closing.
- `lma migrate` off a terminal takes safe actions only, so it cannot hang or delete anything, and it brings the containers up first.
- `lma start` on an unmigrated database starts no apps and says to run `lma migrate`.
- Secrets, dumps, logs and pids moved out of the project to `~/.local-medusa-app/<folder>-<id>/`, moved automatically the first time 0.3.0 runs, along with the logs older versions kept in `node_modules`. Inside the project, the admin's dev server served them to anyone who reached the backend on the network or through a tunnel. Treat secrets from an older install that was published or on a shared network as exposed.
- The nginx proxy binds to `127.0.0.1`. It used to listen on every interface.
- A tunnel refuses to publish a backend whose `JWT_SECRET` or `COOKIE_SECRET` is missing or a public default, or whose `admin.password` is in `lma.js`, and it remembers an account seeded with a guessable password. `lma start` warns about those secrets.
- `lma stop` and `lma destroy` take the tunnel down, and `lma status` says while something is published.
- `lma migrate` and `lma seed-admin` refuse an exported `DATABASE_URL` or a backend `.env` pointing anywhere but this stack's Postgres. They used to follow it, into another project's database after a port moved.
- `lma start`, `lma restart <app>` and `lma init` exit non zero when an app did not come up, and say so when the process is alive with no server under it.
- `lma stop backend` and the like refuse a name instead of acting on the whole stack, and an unknown command exits non zero.
- An `lma` started from inside `lma run` or a dev server acts on the project it stands in, not the outer one.
- `lma init` works in a folder with a space or a `&` in its path, with a backend called `storefront`, and under `npx --package`. A path Medusa cannot run from, with `(` or `[` in it, is refused before anything is installed. A failed install can be run again, a run over an old database is refused, and `--help`, `--dry-run` and `--backend=name` behave.
- Running `lma` with `node_modules` gone can no longer fetch the unrelated npm package called `medusa`, and the printed next steps no longer name the unrelated package called `lma`.
- Passwords are no longer printed by `lma init` or by seeding off a terminal: `lma admin` prints them.
- A server recorded in one locale or timezone is still recognised in another, so `lma stop` no longer abandons it.
- Reading commands and dry runs no longer move a port. Editing a port in the config takes effect. `lma ports --reset` refuses while the stack runs.
- `lma run` returns the command's exit code after ctrl C or SIGTERM, and passwords with url characters make a valid `DATABASE_URL`.
- The store keeps what its `.env.local` sets. Env files read the way dotenv reads them, with CRLF, quotes and comments.
- `lma tunnel` no longer takes a `tail -f` on its log for a running tunnel, says why when Cloudflare cannot be reached, and saves hostnames for an app with a hyphen in its name.

## 0.2.1

- `lma start` waits for a dev server that is restarting instead of launching a second one.
- `lma stop` waits up to 10 s for each dev server and its children, then kills what is left.
- `lma start` and `lma restart` say when a port is not the preferred one.

## 0.2.0

- Local dev improvements, with guarded tunnels and secrets.

## 0.1.0

- Local dev CLI for Medusa projects.

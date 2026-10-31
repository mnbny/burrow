<h1 align="center">Burrow</h1>
 <p align="center">A tiny self-hosted host for static sites. You deploy a folder, you get a URL back, and the deploy quietly deletes itself after it expires. That makes it a good dumping ground for agents: build reports, demos, one-off pages.</p>

<p align="center">
  <img width="480" height="480" alt="image" src="https://github.com/user-attachments/assets/15b2541f-c64a-4555-94b5-d130d8132ea5" />
</p>



```sh
moonbunny deploy ./dist --project demos
# https://static.example.com/demos/1b2a97e0-.../
```

Everything serves from one domain as `/{project}/{slug}/`.

## CLI

Needs Node.js 20 or later and `~/.local/bin` on your `PATH`:

```sh
git clone git@github.com:mnbny/moonbunny-host.git
cd moonbunny-host
node cli/setup.mjs
```

### moonbunny deploy

Ships a directory or a single file to the server, then prints the URL and nothing else, so a script can capture it. If the slug is taken, the server picks a new one, so trust the printed URL over the slug you asked for.

| Flag        | Required | Description                                                          |
| ----------- | :------: | -------------------------------------------------------------------- |
| `--project` |    ✔     | First URL path segment.                                              |
| `--slug`    |          | Second URL path segment. Default: a random UUID.                     |
| `--auth`    |          | `user:pass` required to view this deploy, via a sign-in page.        |
| `--expires` |          | Days until the deploy is deleted. `0` keeps it forever. Default: 30. |
| `--host`    |   ✔\*    | Server URL.                                                          |
| `--token`   |   ✔\*    | A deploy token.                                                      |

\* The `MOONBUNNY_HOST` and `MOONBUNNY_TOKEN` env vars satisfy these; a flag wins when both are set.

The server slugifies names: `"My Report"` becomes `my-report`. A deployed `index.html` serves at the slug root; any other single file serves at its own name.

A protected deploy shows a sign-in page. A correct sign-in sets a cookie for that deploy only, good for 30 days on that device; a server restart signs viewers out.

```sh
# password-protected, gone in 7 days
moonbunny deploy ./coverage --project ci --slug pr-123 --auth me:secret --expires 7

# a single file, kept forever
moonbunny deploy report.html --project docs --expires 0
```

### moonbunny readme

Prints this guide. Working with an agent? Tell it to run `moonbunny readme` and it has everything it needs.

## Server

One container. Run it behind your reverse proxy, which owns the domain and TLS. Allow request bodies at least as large as the upload cap in the proxy.

```sh
docker compose up -d
```

The container fixes the data path's ownership at start and then drops to an unprivileged user (uid 1000).

The compose file pulls the published image and reads these from the environment or a `.env` file beside it:

| Var             | Description                                                      |
| --------------- | ---------------------------------------------------------------- |
| `IMAGE_URL`     | Image to run. Default: the published image.                      |
| `IMAGE_VERSION` | Image tag. Pin a `<commit>` tag to roll back. Default: `latest`. |
| `DEPLOY_TOKENS` | Comma-separated tokens that may deploy.                          |
| `MAX_BODY_MB`   | Upload cap in MB; extracted content caps at 10x. Default `50`.   |
| `DATA_PATH`     | Host path for the deployed content. Default `./data`.            |
| `PORT`          | Published HTTP port. Default `8080`.                             |

## Development

- Node.js 22 or later and pnpm 11.
- `pnpm install`, then `node cli/setup.mjs --dev` to run your working copy as `moonbunny`.
- `pnpm validate` formats, lints, typechecks, and rebuilds the committed `*.bundle.mjs` files. They are generated; never edit them.
- `pnpm test` runs the end-to-end harness: the real container behind a real proxy in Docker, deployed to with the real CLI.
- `pnpm release` builds the image for x86_64 and pushes `:latest` plus an immutable `:<commit>` tag. It refuses a dirty tree.

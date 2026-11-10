# Technical Brief

## Operating Model

The system is one Node server that accepts deploys and serves the deployed files. The server runs as a Docker container on the owner's NAS behind Nginx Proxy Manager. The container copies only the committed server bundle, so the image installs nothing. The proxy owns the public domain and TLS. The server uses plain HTTP on an internal port.

The server stores deployed content on a mounted volume, organized by project and then by slug. A deploy uploads a gzipped tarball of a directory. By default, a taken slug receives a unique suffix and the existing deploy stays unchanged. Explicit replacement requires a named slug and replaces all files there, or creates the deploy if that slug is absent. The server normalizes the project and slug into URL-safe names. It also generates omitted slugs and supplies the default expiration, so every client uses the same naming and lifetime rules. The response carries the final path, and the CLI prints the URL from that response.

Deploys are ephemeral. Each deploy carries a hidden metadata file with its deploy time, its expiration time, and its optional credentials. A sweep at server start, and once each hour after, deletes every deploy past its expiration. A deploy may opt out of expiration.

Replacement preserves the existing credentials and expiration date unless the deploy supplies a new value for that setting. An explicit expiration value starts a new countdown from replacement; a deploy without expiration remains permanent when the value is omitted. Credentials change as a complete username and password pair. Replacement retains no previous versions.

A deploy extracts into an unservable staging area. The server publishes only after the files and metadata are ready. Publication uses synchronous filesystem changes, so requests and other deploys cannot observe an incomplete replacement. If publication fails, the server restores the existing deploy. Concurrent replacements finish in publication order and inherit omitted settings from the latest deploy. Downloads already in progress retain their original files.

## Authentication

- A deploy requires a bearer token. The container environment supplies the valid tokens in one comma-separated variable at start. There is no token management at runtime.
- A deploy may attach viewing credentials. The server stores them in the hidden metadata file inside the slug directory. A read of that slug without a session gets a sign-in page on navigation and a bare refusal otherwise. A correct sign-in sets a signed session cookie scoped to that slug and its credentials. A credential change invalidates existing sessions; a content replacement with unchanged credentials preserves them.
- Sign-in reports invalid credentials in a dismissible toast outside the form. Without JavaScript, the message stays visible and the form still works.
- The session signing key lives only in process memory, so there is nothing to store or leak and a restart signs every viewer out. Credential and token comparisons are timing safe.
- The server never serves a hidden file (a name that starts with a dot). This rule also protects the stored credentials.

## Hardening

- The server never executes uploaded content. It extracts archives and serves files or the built-in viewer. Responses forbid content-type sniffing.
- After extraction the server removes every entry that is not a directory or a regular file with one hard link, so a deploy cannot plant a link that reads outside its own slug.
- The server caps the upload size and the extracted size. Both counts run while the request streams, so an oversized upload or a decompression bomb is stopped before it fills the volume.
- The server writes its metadata file after extraction, so a metadata file inside a deploy never wins over the server's own.
- The host serves a robots rule that forbids all crawling. A file placed at the data root overrides the rule; a deploy cannot create that file.
- The server starts as root only to repair the data path's ownership, then drops to an unprivileged user before it listens, so a code-execution bug in the extraction path does not grant root and an old volume needs no manual migration.

## CLI

The deploy client is a TypeScript CLI that follows the MAACS CLI conventions. A plain Node launcher registers tsx and runs the TypeScript entry point. The CLI has two subcommands: one deploys, and one prints the repository guide, which keeps the guide the single documentation source for people, agents, and scripts. The deploy command archives a directory or a single file with tar and uploads the archive to the deploy endpoint. The command reads the host URL and the token from environment variables or from flags, and a flag wins over its environment variable. The command takes the project, the optional slug, the optional basic auth credentials, and the optional expiration as flags. On success the command prints only the deploy URL to stdout, so a script can capture the URL. The CLI is the only deploy client. Browser pages provide sign-in and Markdown viewing. There is no management UI.

Ready-to-run bundles of the CLI and the server are committed in the repository. Each bundle is one file, runs on an older Node release than development needs, and requires no install. The validation command rebuilds both bundles after its checks pass, so a repository that passes validation carries bundles that match their source. The bundles are generated: tooling does not format, lint, or diff them, and nobody edits them by hand.

A setup script links the CLI onto the user's search path. The script links the bundle by default, so a consumer is finished after one command with nothing installed. A development flag links the TypeScript entry point instead, which runs the working copy as it is edited.

## Markdown Viewing

Browser navigation to a Markdown document opens a viewer. Preview is the default; the URL records the selected preview or source mode. Both modes offer a download of the original file. Scripts receive the original text, and an explicit source request bypasses the viewer. Authentication and expiration apply to the viewer, source, and download. Sign-in preserves the requested mode.

The viewer fetches the original document and renders it in the browser. Marked parses Markdown, and DOMPurify removes unsafe HTML before the viewer displays it. A content security policy permits only the bundled viewer script. Source mode displays literal text. Relative links and images resolve from the document URL. Section links work with generated heading identifiers and sanitized HTML anchors. The uploaded file stays unchanged.

Tailwind and daisyUI supply the Moon Bunny theme for the viewer and sign-in page. Both pages share their fonts, colors, square borders, gradient headings, and outline controls. The build embeds the styles, browser code, and fonts in the server bundle. Neither page needs a CDN or separate asset service. Sign-in works without JavaScript.

Both pages share the Moon Bunny footer. A server setting can remove the footer from both pages. It does not change deployed files.

## Distribution

A release publishes the server image to a container registry with a moving latest tag and an immutable tag that names the commit it was built from. A release runs only from a clean, committed tree, so every tag names its exact source. The compose file pulls the published image instead of building, so the NAS never needs a checkout. A rollback runs the previous commit tag. The test harness is the exception: it always builds the image from the working tree, so it tests the source and not a stale release.

## Testing

One end-to-end harness verifies the host. The harness builds the real container, puts a small nginx proxy in front of it as a stand-in for Nginx Proxy Manager, deploys fixture files with the real CLI, and checks the served responses: token rejection, basic auth, content and asset types, hidden files, traversal, redirects, slug conflicts, slug normalization, expiration, concurrent deploys to one slug, decompression bombs, dropped uploads, and hostile metadata and expiration input. Replacement checks cover complete file replacement, retained settings, unchanged expiration dates, explicit expiration renewal, credential changes, failed uploads, concurrent replacements, and downloads in progress. The harness is sandboxed: it binds only to localhost, exposes the app only through the proxy, and removes every container and network on exit.

The same harness uses Playwright and Chromium to check Markdown views, URL navigation, original downloads, sign-in, sanitization, relative assets, and mobile layout. It also checks that the viewer works with external requests blocked and that downloads work without JavaScript.

## Conventions

- Keep standalone UI components and their supporting assets together. Keep tests, fixtures, and repository automation outside runtime code. Import assets from their source modules, and keep small private helpers near their consumers.
- Dependencies are welcome in the server and the CLI. Each ships as a committed bundle that validation rebuilds, so no runtime ever installs packages.
- The CLI follows the MAACS conventions: citty commands, a tsx launcher, strict TypeScript, and the shared prettier and eslint configuration. One validation command formats, lints, and typechecks the repository, then rebuilds the bundles.
- Keep the input validation at the trust boundary. The token check, the path segment validation, and the dotfile block are not simplification targets.

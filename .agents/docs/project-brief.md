# Project Brief

## Purpose

burrow is a self-hosted host for any static site, for personal use. It exists so the owner and the owner's coding agents can publish static content programmatically and share it at a URL: build reports, demos, one-off pages. Deploys are ephemeral by design, so published content removes itself. It implements only the deploy workflow of a static host such as surge.sh, nothing else.

## Vocabulary

- Project: the first URL path segment. A project groups related deploys.
- Slug: the second URL path segment. A slug identifies one deploy. When the deployer does not name a slug, the slug defaults to a random UUID.
- Deploy: the upload of a directory of static files to one project and slug. Deploys are immutable: when the requested slug is taken, the server appends a unique suffix and the new deploy lands beside the old one. Deploys are ephemeral: each deploy expires after a number of days, 30 by default, and the server deletes expired deploys. A deploy may opt out of expiration.

## Boundaries

- One domain serves everything, addressed by path. There is no subdomain support.
- Content is static files only. The host does not build or execute deployments. A browser viewer displays Markdown without changing the uploaded files.
- A deploy requires a bearer token. A deploy may require viewing credentials, entered through a sign-in page.
- This is not a product. There are no revisions, rollbacks, analytics, teams, plans, or account management, and none are planned.

## Direction

Simplicity is the durable constraint. The owner adds a capability only for a concrete personal need. The smallest version that works is the correct version.

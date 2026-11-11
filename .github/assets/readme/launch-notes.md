# Burrow · Launch notes

A small self-hosted home for static sites. Upload your files and share a URL.

## What's shipping

| Feature          | What it does                                      | Status |
| ---------------- | ------------------------------------------------- | ------ |
| Static hosting   | HTML, CSS, JavaScript, and other static files     | Ready  |
| Markdown viewer  | Readable previews, raw source, and downloads      | Ready  |
| Protected pages  | Username and password sign-in for private links   | Ready  |
| Same-URL updates | Replace a deploy without changing the shared link | Ready  |

> One container. Your domain. Files that clean up after themselves.

## Publish a site

```sh
burrow deploy ./dist --project burrow --slug launch --expires 7
```

## Launch checklist

- [x] Check static pages and linked assets
- [x] Add launch screenshots to the README
- [ ] Share the release notes

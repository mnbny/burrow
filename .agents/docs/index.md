# Documentation Registry

## How to Read

Read this registry to determine whether documentation applies to the current task. Read a registered document only when explicitly asked or when its description or tags relate to the work. Do not read documentation just because it is available, and do not read unrelated documents.

## How to Update

- Add an entry when a documentation file other than this registry is created.
- Update its entry when the file is renamed or its purpose changes.
- Remove its entry when the file is deleted.
- Use the exact relative file reference or path as the entry heading.
- Keep descriptions terse and limited to the document's purpose and contents. Do not include technical details.
- Use concise tags that are likely to appear in a related task.

### Entry Format

Add each document using this format:

```md
#### [file-name.md](./file-name.md)

- Description: Very brief description of the document's purpose and contents.
- Tags: `related-topic`, `another-topic`
```

## Registry

#### [project-brief.md](./project-brief.md)

- Description: Purpose, scope, boundaries, and vocabulary of the burrow static site host.
- Tags: `purpose`, `scope`, `deploy`, `agents`, `hosting`

#### [technical-brief.md](./technical-brief.md)

- Description: Operating model of the server, CLI, storage, authentication, reverse proxy, distribution, and testing, and the project conventions.
- Tags: `server`, `cli`, `docker`, `tokens`, `auth`, `sign-in`, `sessions`, `conventions`, `release`, `registry`, `bundles`, `testing`, `security`, `hardening`

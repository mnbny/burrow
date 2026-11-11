# Agent Docs

Read [.agents/docs/index.md](./.agents/docs/index.md).

After a feature or change reaches its logical conclusion, such as during verification or before a commit, use the `ir-living-docs` skill to update the living documentation. Do not do this preemptively.

## README

Before editing `README.md`, use this repository's `writing.readme` Woof token.

## Run Validations Smartly

Validation command: `pnpm validate`

It formats, lints, and typechecks the repository, then rebuilds the committed bundles. Run it when it is logically appropriate, not after every iteration. Examples:

- After a feature implementation is fully complete.
- Before staging or committing files.
- When asked by the user.

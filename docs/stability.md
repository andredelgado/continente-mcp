# Stability

While Continente MCP is at 0.x, a minor release can change its tool contract. Check the
[changelog](https://github.com/andredelgado/continente-mcp/blob/main/CHANGELOG.md) before updating a client that relies on these fields.
Starting with 1.0.0, breaking changes require a new major version under
[Semantic Versioning](https://semver.org/).

## The contract

- **Tools:** their names, and their input parameters: names, types, accepted values and
  defaults.
- **Results:** the fields of `structuredContent`, with their types and meanings: the
  `status` values (`success`, `partial`, `empty`, `error`), every `data` field, error `code`
  and `retryable`, and the `mutation` and `signIn` details of errors.
- **Cart safety:** every cart change is confirmed by reading the cart back; a change whose
  outcome cannot be confirmed is reported as `unknown` and never repeated automatically.
- **The prompts** `basket-planner` and `label-check` and their argument, and **the resource**
  `ui://continentept-mcp/choose-products.html` (the product picker).

[`test/contract/tools.json`](https://github.com/andredelgado/continente-mcp/blob/main/test/contract/tools.json) pins the tools' names, titles,
hints and schemas, so CI fails on any change until it is made on purpose.

## What counts as breaking

- Removing or renaming a tool, an input parameter, a result field, an enum value or an error
  code.
- Changing a field's type or meaning, or what a status or error code means.
- Making an optional input required, accepting fewer input values, or changing a default in a
  way that changes the result.
- Weakening the cart-safety rules above.
- Dropping a Node.js version that is still maintained upstream.

## What does not

Can come in any minor or patch release:

- New tools, new optional inputs and new result fields.
- New values in the two open lists: error `code` and `promotions[].kind`. Treat an
  unknown error code like any other error with its `retryable` flag, and an unknown
  promotion kind like `other`. Every other enum is closed.
- The text in `content`, which is written for the assistant and the person to read. Its wording
  can change; read `structuredContent` for anything a program depends on.
- Tool and field descriptions, the server instructions and the prompt's wording.
- Fixes for changes on Continente.pt, performance changes and documentation.
- Dropping a Node.js version after it reaches end of life upstream.

## Changes on the website

The server reads Continente.pt, which can change at any time. When it does, a tool can return
`partial` results, unknown values or an error until a patch release adapts to it. That follows
the contract: the server reports what it could not read instead of guessing. A scheduled
check runs every week against the live site and opens an issue when something no longer parses.

## Deprecation

Before something is removed in a major release, it is marked as deprecated in the changelog,
in this documentation and in the tool's description for at least one minor release, with what
to use instead.

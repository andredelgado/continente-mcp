# Shopping extension security review

The extension binds saved sessions to the configured account and restricts coupon and pickup operations to verified routes.

## Implemented controls

- Normal and login browsers request Chromium sandboxing. Startup fails rather than retrying without it.
- Saved cookies use a private, versioned envelope bound to the configured email fingerprint. Legacy unbound sessions and sessions bound to another configured email require a fresh login.
- Before saving a new session or reusing saved cookies, the server checks the populated readonly email field on the retailer's personal-details page against the configured email. The value is compared internally and is never logged or returned. Missing or mismatched identity fails closed.
- Cart and coupon writes accept only specific retailer controller paths and observed HTTP methods. They reject foreign origins, query strings and fragments in supplied form actions.
- Browser request interception blocks payment, order submission and slot reservation paths before transmission. It also blocks external document navigation. Service workers are disabled so they cannot bypass these browser routes.
- Explicit payment navigation is rejected before creating a browser. API reads and writes do not follow redirects automatically.
- Coupon selection uses fresh basket form fields and verifies the resulting selected IDs. An ambiguous result is reported as unknown and is not automatically replayed. Unreadable post-write selections stay `null`; older observations are kept separately with explicit recovery instructions.
- Store discovery sends the observed read-only GET request and does not call the store-context or reservation endpoints.
- `set_pickup_store` accepts only a fresh primary-store option, calls the exact observed coverage GET and context POST endpoints, and reads the selected-store context back. An uncertain POST is never retried; a confirmed change asks callers to re-read cart/coupon context.
- `list_pickup_slots` reads raw server-rendered HTML and reports slots only when one primary pickup step, selected radio, current store marker and shipment identifiers agree. Date windows are limited to the next 31 days because the retailer omits the year from slot labels.
- Basket summaries keep earned loyalty credit separate from the displayed amount to pay. The `immediateDiscounts` value reports order and shipping discounts only; it is not all coupon or line-level savings. Missing credit stays unknown.

## Remaining limits

Changing a password without changing the email does not invalidate the saved envelope. No password-derived fingerprint is stored.

Coupon eligibility and stacking are not inferred from a percentage alone. A selected coupon is not proof that its benefit applies to every product. The basket summary remains provisional.

Pickup-store context mutation is supported through `set_pickup_store`; pickup-slot reservation remains unavailable. `list_pickup_slots` reads only slot data already rendered in server HTML; it does not execute the delivery page's automatic slot-selection JavaScript or request additional dates. Results therefore remain partial when any slots are present. The MCP tools themselves use direct HTTP reads and do not run that page JavaScript.

The current verified mutation contract changes stores only after pickup mode is already active. Switching from home delivery to pickup is not exposed because its selected-context/readback contract has not been verified.

Pickup availability is a subset of the delivery-slot proposal in [issue #7](https://github.com/andredelgado/continente-mcp/issues/7).
It includes `observedAt` and the last observed `catalogView`, but does not expose home-delivery
slots, explicit per-slot availability or delivery thresholds. The automated suite cannot establish
that a live retailer GET has no server-side effects. Live-account validation with redacted response
fixtures and before/after checks of account and cart state remains necessary before claiming that
issue is fully implemented.

The tests use synthetic coupon, store, shipment and session data. Geographic examples use Coimbra with illustrative coordinates and postal codes; they are not customer addresses or captured account data. Mutation clients use synthetic transports. Authenticated retailer mutations are not part of the automated suite.

## Validation

Run the following checks on the current source:

```sh
npm run typecheck
npm test
npm run test:package
npm run test:browser
npm run build:bundle
npm audit --omit=dev
```

Browser tests serve local fixtures and block external requests. Package checks start an installed tarball with isolated application state and no configured account credentials.

## Dependency audit

Run `npm audit --omit=dev` for the current production dependency report.

The development-only chain `@anthropic-ai/mcpb` → `node-forge@1.4.0` is affected by [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), concerning RSA PKCS#1 v1.5 signature verification. Recheck the full development dependency audit before relying on bundle signature verification.

These checks cover the reviewed code and the reported dependency graph; they do not establish that the retailer or the host environment is free of vulnerabilities.

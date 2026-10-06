# @cloudforge-ai/culqi

> Previously published as `@jibaru/culqi`. New versions are published here, under `@cloudforge-ai/culqi`.

Type-safe, zero-dependency TypeScript SDK for the [Culqi](https://culqi.com/) payments API (Peru).

> Unofficial. Culqi does not publish a Node.js SDK; this one is built against the
> official [docs](https://docs.culqi.com/) and [API reference](https://apidocs.culqi.com/),
> and every endpoint is verified with integration tests against Culqi's test environment.

- **Complete**: tokens, charges (incl. pre-authorization + capture), refunds, customers, saved cards, orders, recurrent plans & subscriptions, webhooks, browser checkout, optional AES/RSA payload encryption.
- **Zero runtime dependencies**, native `fetch`, Node ≥ 18.
- **Dual ESM/CJS**, full TypeScript types, typed error classes.
- **Two entries**: `@cloudforge-ai/culqi` (server, secret key) and `@cloudforge-ai/culqi/checkout` (browser, public key) — server code never reaches your bundle.

## Install

```bash
npm install @cloudforge-ai/culqi
```

## Quickstart

**Browser** — tokenize with Culqi Checkout (card data never touches your server):

```ts
import { loadCheckoutScript, openCheckout } from "@cloudforge-ai/culqi/checkout";

await loadCheckoutScript();
openCheckout({
  publicKey: "pk_test_...",
  title: "My Store",
  amount: 8000, // cents: S/ 80.00
  currency: "PEN",
  mode: "modal", // or "embedded" + containerId
  onToken: (token) => fetch("/api/pay", { method: "POST", body: JSON.stringify({ tokenId: token.id }) }),
  onError: (err) => console.error(err.user_message),
});
```

**Server** — charge the token:

```ts
import { Culqi } from "@cloudforge-ai/culqi";

const culqi = new Culqi({ secretKey: process.env.CULQI_SECRET_KEY });

const charge = await culqi.charges.create({
  amount: 8000,
  currency_code: "PEN",
  email: "customer@example.com",
  source_id: tokenId,
});
// charge.outcome.type === "venta_exitosa" -> paid. The response is final.
```

## Flows

### Pre-authorization: hold now, capture on approval

```ts
const hold = await culqi.charges.create({ ...params, capture: false });
await culqi.charges.capture(hold.id); // approve
// or release the hold:
await culqi.refunds.create({ charge_id: hold.id, amount: hold.amount, reason: "solicitud_comprador" });
```

Cards only — Yape has no pre-authorization.

### Refunds (partial or total)

```ts
await culqi.refunds.create({ charge_id, amount: 2000, reason: "solicitud_comprador" });
```

### Card-on-file (one-click payments)

```ts
const customer = await culqi.customers.create({ first_name, last_name, email, address, address_city, country_code: "PE", phone_number });
const card = await culqi.cards.create({ customer_id: customer.id, token_id });
await culqi.charges.create({ ...params, source_id: card.id });
```

### Orders: wallets, Cuotéalo, PagoEfectivo, bank apps, agents

```ts
const order = await culqi.orders.create({ amount, currency_code: "PEN", description, order_number, client_details, expiration_date });
// payment happens outside your app -> listen for the `order.status.changed` webhook
```

Wallets, Cuotéalo, PagoEfectivo, bank apps and agents need the order in `orderId`, and come
back through `onOrder` instead of `onToken`. Two limits the API only mentions when it rejects
you: `amount` must be at least 600 (S/ 6.00) and `client_details.phone_number` is required.

```ts
openCheckout({ ...opts, orderId: order.id, onOrder: () => confirmOnServer(order.id) });
// onOrder means "the modal finished" -> verify with orders.get(id).state === "paid"
```

**Yape needs none of this.** It is a token method like a card; it only disappears from the
modal when the amount is under 600 (S/ 6.00).

### Subscriptions

```ts
const { id: planId } = await culqi.plans.create({ name, short_name, description, amount, currency: "PEN", interval_unit_time: 3, interval_count: 1, initial_cycles: { count: 0, has_initial_charge: false, amount: 0, interval_unit_time: 3 } });
await culqi.subscriptions.create({ card_id, plan_id: planId, tyc: true });
```

### Webhooks

Culqi does **not** sign webhooks (no HMAC), but the panel can send credentials: turn on
"Activar autenticación" when creating the webhook (the username is capped at 20 characters) and
check them with `verifyWebhookBasicAuth`, which compares in constant time. Then re-fetch the
resource before trusting the payload:

```ts
import { parseWebhookEvent, verifyWebhookBasicAuth } from "@cloudforge-ai/culqi";

if (!verifyWebhookBasicAuth(req, { username, password })) return new Response(null, { status: 401 });

const event = parseWebhookEvent(rawBody);
if (event.type === "charge.creation.succeeded") {
  const charge = await culqi.charges.get((event.data as { id: string }).id);
}
```

### AES/RSA payload encryption (optional)

A second protection layer on top of TLS, [documented by Culqi](https://docs.culqi.com/es/documentacion/pagos-online/llaves_rsa/). Generate keys in CulqiPanel → Desarrollo → RSA Keys and pass them to the client — every request body is then encrypted (AES-256-GCM + RSA-OAEP-SHA256, same wire format as the official SDKs) and the `x-culqi-rsa-id` header is sent automatically:

```ts
const culqi = new Culqi({
  secretKey: process.env.CULQI_SECRET_KEY,
  encryption: {
    rsaId: process.env.CULQI_RSA_ID,
    rsaPublicKey: process.env.CULQI_RSA_PUBLIC_KEY, // PEM
  },
});
```

Uses WebCrypto — works in Node ≥ 18 and edge runtimes, still zero dependencies.

## Error handling

```ts
import { CulqiCardError, CulqiAuthenticationError, CulqiError } from "@cloudforge-ai/culqi";

try {
  await culqi.charges.create(params);
} catch (err) {
  if (err instanceof CulqiCardError) show(err.userMessage); // declined; see err.declineCode
  // Culqi sends declines as type "operacion_denegada" (not "card_error"); the SDK maps both.
  else if (err instanceof CulqiAuthenticationError) alertOps("check API keys");
  else if (err instanceof CulqiError) log(err.status, err.type, err.merchantMessage);
}
```

## Agent skill

This repo ships an [Agent Skill](https://github.com/Cloudforge-AI/culqi/tree/main/skills/integrate-culqi) that teaches coding agents (Claude Code, Cursor, etc.) to integrate Culqi correctly — flows, pitfalls, and test cards included:

```bash
npx skills add Cloudforge-AI/culqi --skill=integrate-culqi
```

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test   # unit (mocked fetch)
CULQI_SECRET_KEY=sk_test_... CULQI_PUBLIC_KEY=pk_test_... npm run test:integration
npm run build
```

## Official references

- [Culqi docs](https://docs.culqi.com/) · [API reference](https://apidocs.culqi.com/)
- [Checkout Custom](https://docs.culqi.com/es/documentacion/checkout/checkout-custom)
- [Webhooks](https://docs.culqi.com/es/documentacion/pagos-online/webhooks/)
- [API keys](https://docs.culqi.com/es/documentacion/pagos-online/llaves) · [CulqiPanel](https://culqipanel.culqi.com/login)

## License

MIT

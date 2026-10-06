---
name: integrate-culqi
description: Integrate Culqi (Peruvian payment gateway) into a TypeScript/JavaScript project quickly and correctly, using the @cloudforge-ai/culqi SDK. Covers checkout tokenization, immediate charges, pre-authorization + capture, refunds, card-on-file, async orders, subscriptions, and webhooks. Use when the user wants to accept payments with Culqi, add card/Yape payments in Peru, or debug a Culqi integration.
---

# Integrate Culqi in TypeScript

Culqi is a Peruvian payment gateway (cards, Yape, PagoEfectivo, installments).
This skill gets a working integration fast and routes you around the pitfalls
that are not obvious from the docs.

Official sources — always verify current behavior against these:

- Docs: https://docs.culqi.com/
- API reference: https://apidocs.culqi.com/
- Panel (keys, webhooks): https://culqipanel.culqi.com/login
- Merchant signup: https://afiliate.culqi.com/ (requires a Peruvian RUC — there
  is no keyless sandbox; test keys require a merchant account)

## Setup

```bash
npm install @cloudforge-ai/culqi
```

Keys live in CulqiPanel → Desarrollo → API Keys. Two pairs: `*_test_*`
(integration environment, no real money) and `*_live_*` (production).

```
CULQI_PUBLIC_KEY=pk_test_...   # browser-safe; can only create tokens
CULQI_SECRET_KEY=sk_test_...   # server-only; full API access
```

Never expose the secret key to the browser. Never send card numbers to your
own server — tokenize in the browser with Culqi Checkout.

## Architecture: every flow is token-first

```
Browser ── card or Yape ─> Culqi (checkout script) ──> token (tkn_...)
Browser ── token id ───> Your server
Server ── token + sk ──> Culqi API ──> charge / saved card / ...
```

## Choosing the flow

| You need | Flow | Sync? |
|---|---|---|
| Charge a card or Yape now | `charges.create` | Yes — response is final (Yape needs amount >= 600) |
| Hold now, charge on approval | `charges.create({ capture: false })` → `charges.capture` | Yes |
| Money back / release a hold | `refunds.create` | Yes (bank settlement takes days in prod) |
| One-click repeat payments | `customers` + `cards`, then charge with `crd_...` | Yes |
| Wallets, Cuotéalo, PagoEfectivo, bank apps, agents | `orders.create` **first**, then Checkout with that `ord_...` | **No — webhook or polling required** |
| Recurring billing | `plans` + `subscriptions` (under `/v2/recurrent/`) | — |

## Recipes

### 1. Browser: tokenize with Culqi Checkout

```ts
import { loadCheckoutScript, openCheckout } from "@cloudforge-ai/culqi/checkout";

await loadCheckoutScript();
openCheckout({
  publicKey: process.env.NEXT_PUBLIC_CULQI_PUBLIC_KEY!,
  title: "My Store",
  amount: 8000, // integers, in cents: S/ 80.00
  currency: "PEN",
  mode: "modal", // or "embedded" + containerId: "my-div-id"
  onToken: (token) => sendToBackend(token.id),
  onError: (err) => show(err.user_message),
});
```

Embedded mode gotcha: Culqi injects an iframe with no dimensions — it renders
at the browser default 150px and looks cut off. Force it to fill:

```css
#my-div-id iframe { width: 100%; height: 100%; border: 0; }
#my-div-id { height: 680px; }
```

### 2. Server: charge (the response IS the payment state)

```ts
import { Culqi, CulqiCardError } from "@cloudforge-ai/culqi";

const culqi = new Culqi({ secretKey: process.env.CULQI_SECRET_KEY! });

const charge = await culqi.charges.create({
  amount: 8000, // ALWAYS compute server-side; never trust the client
  currency_code: "PEN",
  email,
  source_id: tokenId,
});
// charge.outcome.type === "venta_exitosa" -> paid, right now, done.
// Declines throw CulqiCardError (check .declineCode).
```

A decline does **not** arrive as `type: "card_error"`, whatever you would expect. The real
shape, verified against the integration environment with card `4000 0200 0000 0000`:

```json
{ "object": "error", "type": "operacion_denegada", "code": "DNGE0031",
  "decline_code": "stolen_card", "merchant_message": "Tarjeta robada." }   // HTTP 400
```

For card/Yape charges you do NOT need a webhook to know the payment happened —
the synchronous response is authoritative. Webhooks are the safety net for
"my server crashed between charging and persisting".

### 3. Yape: it is the amount, not the order

Yape is a token method, exactly like a card: the buyer pays inside the modal, you get a
`tkn_...` in `onToken`, and you charge it with `charges.create`. No order, no webhook.

The one thing that hides it is the amount. **Below S/ 6.00 the modal renders card fields only**,
and it does so silently — no error, no warning, just no Yape tab. Measured against both the test
and the live environment, with no order in play:

| Amount | Yape tab |
|---|---|
| S/ 1.00 | no |
| S/ 5.00 | no |
| S/ 5.99 | no |
| S/ 6.00 | **yes** |
| S/ 12.00 | **yes** |

```ts
openCheckout({
  publicKey, title: "My Store",
  amount: 600,               // < 600 -> cards only, no matter what you pass below
  currency: "PEN",           // required for Yape
  paymentMethods: { tarjeta: true, yape: true },  // already the SDK default
  onToken: (token) => chargeOnServer(token.id),   // card AND Yape end up here
  onError: (err) => show(err.user_message),
});
```

If your cheapest product costs less than S/ 6.00, no flag will bring Yape back: raise the price
or tell the buyer that item is card-only.

**Don't debug this the way I did.** A missing Yape tab at S/ 5.00 looks exactly like a
configuration problem, and the docs sentence *"si el parámetro order se encuentra vacío,
solamente mostrará pago con tarjetas"* makes `orders.create` look like the answer. It is not —
that line is about PagoEfectivo, wallets and Cuotéalo (recipe 4). Change one variable at a
time: same amount with and without the order, then same setup at two amounts.

### 4. Orders: PagoEfectivo, wallets, bank apps, agents, Cuotéalo

These methods *do* need an `ord_...` in `settings.order`, and the order carries two
constraints the API only mentions when it rejects you: `amount` of at least 600, and a real
`client_details.phone_number`, so your UI has to ask for a phone.

```ts
const order = await culqi.orders.create({
  amount: 1200,
  currency_code: "PEN",
  description: "Two flowers frame",
  order_number: myOrderId,   // your id; it comes back in the webhook
  expiration_date: Math.floor(Date.now() / 1000) + 2 * 60 * 60,
  client_details: { first_name, last_name, email, phone_number: "9XXXXXXXX" },
  metadata: { pedido: myOrderId },
});

openCheckout({ ...opts, orderId: order.id, onOrder: () => confirmOnServer(myOrderId) });
```

`onOrder` means "the modal finished", not "the money arrived" — confirm server-side with
`orders.get(id).state === "paid"`, idempotently, because the webhook may get there first.

Orders you create and nobody pays stay `pending` in CulqiPanel next to the real charge, which
looks like a duplicate sale to whoever reads the dashboard. Keep expirations short, and delete
the order (`orders.delete`) if the buyer ends up paying another way.

### 5. Pre-authorization: hold now, charge on approval

```ts
const hold = await culqi.charges.create({ ...params, capture: false });
// hold.capture === false, hold.capture_date === null

await culqi.charges.capture(hold.id); // approve -> money moves

await culqi.refunds.create({
  // reject -> release the hold
  charge_id: hold.id,
  amount: hold.amount,
  reason: "solicitud_comprador",
});
```

Cards only — Yape does not support pre-authorization. Holds expire (industry
norm ~7 days; confirm the exact window with Culqi for production). The
customer sees the amount held from step 1: say so in your UI.

### 6. One-click payments (card-on-file)

**First purchase** — the user checks out normally and opts in to saving the
card ("remember this card"). Save the token as a card first, then charge the
saved card — one code path for both the first and every later purchase:

```ts
const customer = await culqi.customers.create({
  first_name, last_name, email,
  address, address_city, country_code: "PE", phone_number,
});
const card = await culqi.cards.create({
  customer_id: customer.id,
  token_id: tokenId, // saving does not charge
});
const charge = await culqi.charges.create({ ...params, source_id: card.id });
// persist card.id against your user
```

**Every later purchase** — no card form at all, just a "Pay" button:

```ts
await culqi.charges.create({ ...params, source_id: savedCardId }); // crd_...
```

Notes (verified against the integration environment):

- A token can be used for a charge AND to create a card, in either order —
  tokens are not one-shot across operations. Charge-then-save also works.
- A charge with `source_id: crd_...` can fail at that moment (expired card,
  no funds) — handle `CulqiCardError` on the one-click path too.
- Only save the card with explicit user consent, and store nothing but the
  `crd_...` / `cus_...` ids — the card lives in Culqi's vault.

### 7. Webhooks (Culqi does NOT sign them)

There is no HMAC signature header, but the panel does offer credentials. When you create the
webhook, turn on **"Activar autenticación"** and set a user and password — Culqi then sends them
as HTTP Basic auth. The username field is capped at **20 characters**, so an email does not fit;
use something like `culqi-hook`.

```ts
import { parseWebhookEvent, verifyWebhookBasicAuth } from "@cloudforge-ai/culqi";

export async function handler(req: Request) {
  if (!verifyWebhookBasicAuth(req, {
    username: process.env.CULQI_WEBHOOK_USER!,
    password: process.env.CULQI_WEBHOOK_PASSWORD!,
  })) {
    return new Response(null, { status: 401 });
  }

  const event = parseWebhookEvent(await req.text());
  // The payload is a hint, not proof — re-fetch before acting:
  if (event.type.startsWith("charge.")) {
    const charge = await culqi.charges.get((event.data as { id: string }).id);
    // act on `charge`, idempotently (events can arrive more than once)
  }
  return Response.json({ received: true }); // 2xx fast, or Culqi retries
}
```

`verifyWebhookBasicAuth` compares in constant time and takes either the `Request` or the raw
header string. If the panel you are on has no auth toggle, the fallback is a long random token
in the URL (`?token=...`) checked the same way. Either way, the credential only proves *who
called*; the payload still gets re-fetched below.

**Subscribe to the right events in CulqiPanel.** This bites people:
`order.creation.succeeded` fires when *you* create the order, before anyone pays, so on its
own it never confirms anything. For money actually arriving you want:

| Event | Fires when | Use it for |
|---|---|---|
| `order.status.changed` | the order is paid (or expires) | Yape, wallets, PagoEfectivo |
| `charge.creation.succeeded` | a charge succeeds | safety net for cards |
| `order.creation.succeeded` | you create the order | logging, nothing else |

Write the handler so the event *type* barely matters — re-fetch and let the resource's state
decide. Then whatever the panel is subscribed to, the result is the same:

```ts
const id = (event.data as { id?: string })?.id;
if (event.type.startsWith("order.") && id) {
  const order = await culqi.orders.get(id);
  if (order.state === "paid") markPaid(order.id); // idempotent
} else if (event.type.startsWith("charge.") && id) {
  const charge = await culqi.charges.get(id);
  if (charge.outcome?.type === "venta_exitosa") markPaid(charge.metadata?.pedido);
}
```

`data` may arrive as a JSON *string* — `parseWebhookEvent` handles both. Localhost is
unreachable for Culqi: use a tunnel (ngrok/cloudflared) during development.

### 8. AES/RSA payload encryption (optional hardening)

Culqi supports encrypting request payloads on top of TLS
(https://docs.culqi.com/es/documentacion/pagos-online/llaves_rsa/). Generate
keys in CulqiPanel → Desarrollo → RSA Keys, then:

```ts
const culqi = new Culqi({
  secretKey: process.env.CULQI_SECRET_KEY!,
  encryption: { rsaId: process.env.CULQI_RSA_ID!, rsaPublicKey: process.env.CULQI_RSA_PUBLIC_KEY! },
});
```

The SDK handles the wire format (AES-256-GCM with the GCM tag stripped,
key/IV wrapped with RSA-OAEP-SHA256, `x-culqi-rsa-id` header). Only enable it
if the merchant has RSA keys configured in the panel.

## Pitfalls checklist

- **Two hosts.** Tokens go to `secure.culqi.com/v2`; everything else to
  `api.culqi.com/v2`. Posting tokens to the api host fails with a misleading
  "malformed Authorization header" error. The SDK routes this for you.
- **Amounts are integer cents.** `8000` = S/ 80.00. Floats will corrupt money.
- **Compute the amount server-side.** The browser only sends a token id.
- **The generic auth error lies.** "Olvidaste indicar tu API Key… formato
  Bearer" usually means the key is *invalid/revoked*, not malformed.
- **Legacy plans endpoint is dead.** `/v2/plans` returns an empty body; use
  `/v2/recurrent/plans/*` (the SDK does).
- **Order initial state varies**: `created` (with `confirm: false`) or
  `pending` — treat both as "not yet paid".
- **Idempotency is yours — and tokens are NOT single-use.** Verified: the same
  token can be charged twice, both succeeding. A double submit of the same
  `tokenId` is a double charge. Culqi documents no idempotency-key header;
  dedupe server-side by your own order/booking id before calling
  `charges.create`, and disable the pay button after the first click.
- **Declines are `operacion_denegada`, not `card_error`.** The SDK maps both (and anything
  carrying a `decline_code`) to `CulqiCardError` from 0.2.2 on; on 0.2.1 and earlier a decline
  reaches you as a generic `CulqiError`, so `err instanceof CulqiCardError` silently misses it
  and the shopper sees "something went wrong" instead of "your card was declined".
- **Test and live are separate universes.** An `ord_test_...` fetched with an `sk_live_` key
  answers *"No existe el siguiente order_id"*. That error usually means mixed environments, not
  a missing resource.
- **There is no close event.** Checkout never tells you the buyer dismissed the modal, and the
  SDK has no `onClose`. Re-enable your pay button right after `openCheckout` returns, and keep
  the pending order id around so a retry reuses it instead of creating another one.
- **`NEXT_PUBLIC_*` keys are inlined at build time.** If your Docker image builds without the
  env (Dokploy, Railway, most CI), the public key ends up `undefined` in the bundle. Read it in
  a server component and pass it down as a prop.
- **3DS**: in production some issuers require it; the charge response asks for
  authentication and you retry with `authentication_3DS` fields. See
  https://docs.culqi.com/ (Culqi 3DS).

## Automating the checkout in end-to-end tests

The modal lives in an iframe at `https://checkoutview.culqi.com/`, and its inputs have no
stable names — target the placeholders (Playwright):

```ts
await page.click("text=Pagar S/");
await page.waitForTimeout(5000);                       // the iframe mounts late
const form = page.frames().find((f) => /culqi/.test(f.url()))!;
await form.getByPlaceholder("#### #### #### ####").fill("4111111111111111");
await form.getByPlaceholder("MM/AA").fill("12/30");
await form.getByPlaceholder("CVV").fill("123");
await form.getByRole("button", { name: /Pagar/i }).first().click();
```

Checking which methods the modal offers is one line — handy to assert that your order made the
Yape tab appear:

```ts
console.log(await form.locator("body").innerText());
// "… | Tarjeta débito / crédito | Yape | …"  -> order was accepted
// "… | Número de Tarjeta | …"                -> no order: cards only
```

Yape itself cannot be automated: it asks for a real phone and its app code.

## Getting the merchant account approved (Peru)

Culqi reviews the live site before enabling live keys, and rejects on content, not on code.
What they check:

- **Five products minimum**, each with photo, clear description and visible price. Services can
  be fewer, depending on the business.
- **A cart or a buy button**, and test credentials (user and password) if the flow needs login.
- **Contact data visible**: phone, email, address. Social icons, if any, must link to real
  accounts.
- **Terms and conditions** and a **returns/exchange policy**.
- **Libro de Reclamaciones built into the site**, per INDECOPI — not a Google Form, not a PDF,
  not an external link.
- **SSL on every URL**, not only the home page.

Plan for this early: it is a week of content and legal pages, and it blocks the live keys.

## Test cards (integration environment)

| Brand | Number | CVV | Result |
|---|---|---|---|
| Visa | 4111 1111 1111 1111 | 123 | Approved |
| Mastercard | 5111 1111 1111 1118 | 039 | Approved |
| Amex | 3712 121212 12122 | 2841 | Approved |
| Visa | 4000 0200 0000 0000 | 123 | Declined |

Any future expiry date, any email. Full list: https://docs.culqi.com/

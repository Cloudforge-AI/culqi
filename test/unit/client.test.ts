import { describe, expect, it, vi } from "vitest";
import {
  Culqi,
  CulqiAuthenticationError,
  CulqiCardError,
  CulqiConnectionError,
  CulqiError,
  culqiErrorFromResponse,
  CulqiInvalidRequestError,
} from "../../src/index.js";
import type { FetchLike } from "../../src/index.js";

function mockFetch(status: number, body: unknown): FetchLike {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe("Culqi client", () => {
  it("requires at least one key", () => {
    expect(() => new Culqi({})).toThrow(/secretKey.*publicKey/);
  });

  it("throws on server resources without secretKey", () => {
    const culqi = new Culqi({ publicKey: "pk_test_x" });
    expect(() => culqi.charges).toThrow(/secretKey/);
  });

  it("allows tokens.create with only a publicKey", async () => {
    const fetch = mockFetch(200, { object: "token", id: "tkn_test_1" });
    const culqi = new Culqi({ publicKey: "pk_test_x", fetch });
    const token = await culqi.tokens.create({
      card_number: "4111111111111111",
      cvv: "123",
      expiration_month: "09",
      expiration_year: "2028",
      email: "a@b.com",
    });
    expect(token.id).toBe("tkn_test_1");
    expect(fetch).toHaveBeenCalledWith(
      "https://secure.culqi.com/v2/tokens",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer pk_test_x",
        }),
      })
    );
  });

  it("sends charges to api.culqi.com with the secret key", async () => {
    const fetch = mockFetch(200, { object: "charge", id: "chr_test_1" });
    const culqi = new Culqi({ secretKey: "sk_test_x", fetch });
    await culqi.charges.create({
      amount: 8000,
      currency_code: "PEN",
      email: "a@b.com",
      source_id: "tkn_test_1",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.culqi.com/v2/charges",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk_test_x",
        }),
        body: JSON.stringify({
          amount: 8000,
          currency_code: "PEN",
          email: "a@b.com",
          source_id: "tkn_test_1",
        }),
      })
    );
  });

  it("serializes list query params", async () => {
    const fetch = mockFetch(200, { data: [] });
    const culqi = new Culqi({ secretKey: "sk_test_x", fetch });
    await culqi.charges.list({ limit: 5, email: "a@b.com" });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.culqi.com/v2/charges?limit=5&email=a%40b.com",
      expect.anything()
    );
  });

  it("maps authentication errors", async () => {
    const fetch = mockFetch(401, {
      object: "error",
      type: "authentication_error",
      merchant_message: "bad key",
    });
    const culqi = new Culqi({ secretKey: "sk_test_x", fetch });
    await expect(culqi.charges.get("chr_x")).rejects.toBeInstanceOf(
      CulqiAuthenticationError
    );
  });

  it("maps card errors with decline metadata", async () => {
    const fetch = mockFetch(400, {
      object: "error",
      type: "card_error",
      code: "card_declined",
      decline_code: "insufficient_funds",
      user_message: "declined",
    });
    const culqi = new Culqi({ secretKey: "sk_test_x", fetch });
    const error = await culqi.charges
      .create({
        amount: 1,
        currency_code: "PEN",
        email: "a@b.com",
        source_id: "tkn_x",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CulqiCardError);
    expect((error as CulqiCardError).declineCode).toBe("insufficient_funds");
  });

  it("maps parameter errors", async () => {
    const fetch = mockFetch(400, {
      object: "error",
      type: "parameter_error",
      param: "amount",
    });
    const culqi = new Culqi({ secretKey: "sk_test_x", fetch });
    await expect(culqi.charges.get("chr_x")).rejects.toBeInstanceOf(
      CulqiInvalidRequestError
    );
  });

  it("wraps network failures in CulqiConnectionError", async () => {
    const fetch: FetchLike = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const culqi = new Culqi({ secretKey: "sk_test_x", fetch });
    await expect(culqi.charges.get("chr_x")).rejects.toBeInstanceOf(
      CulqiConnectionError
    );
  });

  it("routes recurrent plans to /recurrent/plans", async () => {
    const fetch = mockFetch(200, { id: "pln_test_1", slug: "s" });
    const culqi = new Culqi({ secretKey: "sk_test_x", fetch });
    await culqi.plans.create({
      name: "Plan",
      short_name: "plan",
      description: "d",
      amount: 5000,
      currency: "PEN",
      interval_unit_time: 3,
      interval_count: 1,
      initial_cycles: {
        count: 0,
        has_initial_charge: false,
        amount: 0,
        interval_unit_time: 3,
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.culqi.com/v2/recurrent/plans/create",
      expect.anything()
    );
  });
});

describe("decline mapping", () => {
  it("maps operacion_denegada to CulqiCardError (the shape a real decline has)", () => {
    const err = culqiErrorFromResponse(400, {
      object: "error",
      type: "operacion_denegada",
      code: "DNGE0031",
      decline_code: "stolen_card",
      merchant_message: "Tarjeta robada.",
      user_message: "Tu tarjeta fue rechazada.",
    });
    expect(err).toBeInstanceOf(CulqiCardError);
    expect(err.declineCode).toBe("stolen_card");
  });

  it("still maps card_error to CulqiCardError", () => {
    const err = culqiErrorFromResponse(400, { object: "error", type: "card_error" });
    expect(err).toBeInstanceOf(CulqiCardError);
  });

  it("treats any unknown type carrying decline_code as a decline", () => {
    const err = culqiErrorFromResponse(400, {
      object: "error",
      type: "un_tipo_nuevo",
      decline_code: "insufficient_funds",
    });
    expect(err).toBeInstanceOf(CulqiCardError);
  });

  it("leaves a plain 400 without decline_code as a generic CulqiError", () => {
    const err = culqiErrorFromResponse(400, { object: "error", type: "algo_raro" });
    expect(err).toBeInstanceOf(CulqiError);
    expect(err).not.toBeInstanceOf(CulqiCardError);
  });
});

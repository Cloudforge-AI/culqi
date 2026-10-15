import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadCheckoutScript,
  openCheckout,
  type CulqiCheckoutInstance,
} from "../../src/checkout/index.js";

describe("checkout entry (outside a browser)", () => {
  it("loadCheckoutScript rejects in Node", async () => {
    await expect(loadCheckoutScript()).rejects.toThrow(/browser-only/);
  });

  it("openCheckout throws when the script is not loaded", () => {
    expect(() =>
      openCheckout({
        publicKey: "pk_test_x",
        title: "t",
        amount: 100,
        currency: "PEN",
        onToken: () => {},
        onError: () => {},
      })
    ).toThrow(/not loaded/);
  });
});

/** Minimal stand-in for the script Culqi injects. */
function stubCheckout() {
  const calls: { publicKey: string; config: Record<string, unknown> }[] = [];
  const instance: CulqiCheckoutInstance = {
    open: vi.fn(),
    close: vi.fn(),
    culqi: () => {},
    token: null,
    order: null,
    error: null,
  };
  const CulqiCheckout = vi.fn((publicKey: string, config: Record<string, unknown>) => {
    calls.push({ publicKey, config });
    return instance;
  });
  vi.stubGlobal("window", { CulqiCheckout });

  const lastSettings = () => {
    const call = calls.at(-1);
    if (!call) throw new Error("openCheckout was never called");
    return call.config.settings as Record<string, unknown>;
  };

  return { calls, instance, lastSettings };
}

describe("openCheckout config", () => {
  afterEach(() => vi.unstubAllGlobals());

  const base = {
    publicKey: "pk_test_x",
    title: "Store",
    amount: 1200,
    currency: "PEN",
    onToken: () => {},
    onError: () => {},
  };

  it("passes the order id as settings.order (wallets, Cuotealo, PagoEfectivo)", () => {
    const { lastSettings } = stubCheckout();
    openCheckout({ ...base, orderId: "ord_test_1" });
    expect(lastSettings().order).toBe("ord_test_1");
  });

  it("omits settings.order when there is no order", () => {
    const { lastSettings } = stubCheckout();
    openCheckout(base);
    expect(lastSettings()).not.toHaveProperty("order");
  });

  it("lang defaults to auto and passes through when set", () => {
    const { calls } = stubCheckout();
    const lastOptions = () => {
      const call = calls.at(-1);
      if (!call) throw new Error("openCheckout was never called");
      return call.config.options as Record<string, unknown>;
    };
    openCheckout(base);
    expect(lastOptions().lang).toBe("auto");
    openCheckout({ ...base, lang: "es" });
    expect(lastOptions().lang).toBe("es");
  });

  it("routes an order to onOrder and a token to onToken", () => {
    const { instance } = stubCheckout();
    const onToken = vi.fn();
    const onOrder = vi.fn();
    openCheckout({ ...base, orderId: "ord_test_1", onToken, onOrder });

    instance.order = { id: "ord_test_1" };
    instance.culqi();
    expect(onOrder).toHaveBeenCalledWith({ id: "ord_test_1" });
    expect(onToken).not.toHaveBeenCalled();

    instance.order = null;
    instance.token = { id: "tkn_test_1", email: "a@b.c" };
    instance.culqi();
    expect(onToken).toHaveBeenCalledWith({ id: "tkn_test_1", email: "a@b.c" });
  });
});

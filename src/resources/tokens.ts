import type { HttpClient, RequestOptions } from "../http.js";
import type { Metadata, Token } from "../types.js";

export interface CreateTokenParams {
  card_number: string;
  cvv: string;
  expiration_month: string;
  expiration_year: string;
  email: string;
  metadata?: Metadata;
}

/**
 * Card tokenization. Tokens are created against `secure.culqi.com` with the
 * PUBLIC key; in browsers prefer Culqi Checkout (see `@cloudforge-ai/culqi/checkout`)
 * so card data never touches your servers. Server-side creation is meant for
 * testing and PCI-compliant backends only.
 * @see https://apidocs.culqi.com/ (Tokens)
 */
export class Tokens {
  readonly #secure: HttpClient | null;
  readonly #api: HttpClient | null;

  constructor(secure: HttpClient | null, api: HttpClient | null) {
    this.#secure = secure;
    this.#api = api;
  }

  create(params: CreateTokenParams, options?: RequestOptions): Promise<Token> {
    if (!this.#secure) {
      throw new Error("tokens.create requires `publicKey` in the Culqi config");
    }
    return this.#secure.request("POST", "/tokens", params, undefined, options);
  }

  get(id: string, options?: RequestOptions): Promise<Token> {
    if (!this.#api) {
      throw new Error("tokens.get requires `secretKey` in the Culqi config");
    }
    return this.#api.request("GET", `/tokens/${id}`, undefined, undefined, options);
  }
}

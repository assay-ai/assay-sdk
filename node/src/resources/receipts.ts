import type { Money } from "../core/voucher.js";
import { ConfigError, ServerError } from "../errors.js";
import { isObject } from "../core/meta.js";
import type { ClientContext } from "./context.js";

/** `GET /receipts/{intentId}`: one call, with what it cost. Dates are ISO 8601 strings. */
export interface Receipt {
  intentId: string;
  toolId: string;
  providerId: string | null;
  status: string;
  classification: string | null;
  listedPrice: Money;
  chargedPrice: Money;
  withheld: Money;
  createdAt: string;
  settledAt: string | null;
  [key: string]: unknown;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class Receipts {
  constructor(private readonly c: ClientContext) {}

  /**
   * The receipt of a call, by its intent id (`result.receipt.intentId`). Needs the
   * `activity:read` scope.
   */
  async get(intentId: string): Promise<Receipt> {
    if (typeof intentId !== "string" || !UUID.test(intentId)) throw new ConfigError("intentId must be a UUID");
    const { data } = await this.c.api.get(`/receipts/${intentId}`);
    if (!isObject(data) || typeof data.intentId !== "string")
      throw new ServerError("API_BAD_ANSWER", "the receipt answer is not readable");
    return data as Receipt;
  }
}

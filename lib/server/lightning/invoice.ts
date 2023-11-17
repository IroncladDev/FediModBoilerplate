import { invoiceVerificationTimeout } from "@/lib/constants";
import prisma from "@/lib/server/prisma";
import { ZodSchema, z } from "zod";

const { ALBY_ACCESS_TOKEN } = process.env;

if (!ALBY_ACCESS_TOKEN) {
  throw new Error("Missing environment variable ALBY_ACCESS_TOKEN");
}

export interface InvoiceUtilityArgs<Sch extends ZodSchema> {
  /**
   * A Zod Schema for registering and verifying invoices
   */
  schema: Sch;
  /**
   * Whether to securely create, remember, and verify one-time-use invoices
   */
  rememberInvoices?: boolean;
}

/**
 * Lightning Invoice Utility for creating and verifying invoices.
 */
export default class InvoiceUtility<Sch extends ZodSchema> {
  public schema: Sch;
  public rememberInvoices: boolean;

  constructor({ schema, rememberInvoices = false }: InvoiceUtilityArgs<Sch>) {
    this.schema = schema;
    this.rememberInvoices = rememberInvoices;
  }

  /**
   * Post JSON to an Alby API endpoint with a bearer token
   */
  private async postJSON<T = Record<string, any>>(path: string, body: T) {
    return await fetch("https://api.getalby.com" + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ALBY_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  }

  /**
   * Get JSON from an Alby API endpoint with a bearer token
   */
  private async getJSON(path: string) {
    return await fetch("https://api.getalby.com" + path, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ALBY_ACCESS_TOKEN}`,
        Accept: "application/json",
      },
    }).then((r) => r.json());
  }

  /**
   * Create a lightning invoice
   */
  public async createInvoice(
    args: CreateInvoiceArgs,
  ): Promise<CreateInvoiceResponse> {
    try {
      const res = await this.postJSON("/invoices", args);

      if (res.error) {
        throw new Error(res.message);
      }

      return res;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  /**
   * Decode a lightning invoice
   */
  public async decodeInvoice(
    bolt11_invoice: string,
  ): Promise<DecodeInvoiceResponse> {
    try {
      const res = await this.getJSON("/decode/bolt11/" + bolt11_invoice);
      if (res.error) {
        throw new Error(res.message);
      }

      return res;
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  /**
   * Store a server-generated invoice payment hash to the Redis database for future verification
   */
  public async registerInvoiceHash(paymentHash: string) {
    return await prisma?.invoice.create({
      data: { paymentHash },
    });
  }

  /**
   * Verify (and delete) a server-generated invoice payment hash from the Redis database
   */
  public async verifyInvoiceHash(payment_hash: string): Promise<true> {
    const invoice = await prisma?.invoice.findFirst({
      where: { paymentHash: payment_hash },
    });
    const trackedInvoice = invoice?.timeCreated;

    if (!trackedInvoice) {
      throw new Error("Could not find invoice");
    }

    if (
      Date.now() > new Date(trackedInvoice).getTime() &&
      Date.now() - new Date(trackedInvoice).getTime() <=
        invoiceVerificationTimeout
    ) {
      await prisma?.invoice.delete({
        where: { paymentHash: payment_hash },
      });
      return true;
    } else if (
      Date.now() - new Date(trackedInvoice).getTime() >
      invoiceVerificationTimeout
    ) {
      await prisma?.invoice.delete({
        where: { paymentHash: payment_hash },
      });
      throw new Error("Invoice timed out");
    }

    throw new Error("Invoice not verified");
  }

  /**
   * Creates an invoice following the structure of the provided Zod Schema. If `rememberInvoices` is true, the invoice will be stored in the Redis database for future reference.
   */
  public async registerInvoiceWithSchema(
    args: Omit<CreateInvoiceArgs, "description" | "memo">,
    data: z.infer<Sch>,
  ): Promise<CreateInvoiceResponse> {
    try {
      const parserResponse = this.schema.safeParse(data);

      if (parserResponse.success) {
        const res = await this.createInvoice({
          ...args,
          description: Buffer.from(JSON.stringify(data)).toString("base64"),
        });

        if (this.rememberInvoices) {
          await this.registerInvoiceHash(res.payment_hash);
        }

        return res;
      } else {
        throw new Error(parserResponse.error.message);
      }
    } catch (err) {
      console.log(err);
      throw err;
    }
  }

  /**
   * Decodes an invoice encoded with the provided Zod Schema. If `rememberInvoices` is true, throws an error on an invoice not found in the Redis database.
   */
  public async verifyInvoiceWithSchema(bolt11_invoice: string): Promise<{
    invoice: DecodeInvoiceResponse;
    data: z.infer<Sch>;
  }> {
    try {
      const res = await this.decodeInvoice(bolt11_invoice);

      if (!res?.description) {
        throw new Error(
          "Cannot check the structure of a blank invoice description",
        );
      }

      const inv = await this.getJSON("/invoices/" + res.payment_hash);

      if (!inv) {
        throw new Error("Cannot find invoice");
      }

      if (inv.state !== "SETTLED" || !inv.settled) {
        throw new Error("Invoice not paid");
      }

      if (
        inv.statue === "EXPIRED" ||
        Date.now() > new Date(inv.expires_at).getTime()
      ) {
        throw new Error("Invoice expired");
      }

      if (this.rememberInvoices) {
        await this.verifyInvoiceHash(inv.payment_hash);
      }

      const description = Buffer.from(res.description, "base64").toString(
        "utf8",
      );

      const decoded = JSON.parse(description);

      const parserResponse = this.schema.safeParse(decoded);

      if (parserResponse.success) {
        return {
          invoice: res,
          data: parserResponse.data,
        };
      } else {
        throw new Error(parserResponse.error.message);
      }
    } catch (err) {
      console.log(err);
      throw err;
    }
  }
}

export type AvailableCurrency = "bc" | "btc";

export interface CreateInvoiceArgs {
  amount: number;
  description?: string;
  description_hash?: string;
  currency?: AvailableCurrency;
  memo?: string;
  comment?: string;
  metadata?: Record<string, any>;
  payer_name?: string;
  payer_email?: string;
  payer_pubkey?: string;
}

export interface CreateInvoiceResponse {
  amount: number;
  boostagram?: null | any;
  comment?: string | null;
  created_at: string;
  creation_date: number;
  currency: AvailableCurrency;
  custom_records?: Record<string, any> | null;
  description_hash?: null | string;
  expires_at: string;
  expiry: number;
  fiat_currency: "USD" | string;
  fiat_in_cents: number;
  identifier: string;
  keysend_message?: string;
  memo?: string | null;
  payer_name?: string | null;
  payer_email?: string | null;
  payer_pubkey?: string | null;
  payment_hash: string;
  payment_request: string;
  r_hash_str?: string | null;
  settled?: null | boolean;
  settled_at?: null | string | number;
  state: "CREATED" | "SETTLED" | string;
  type: "incoming" | "outgoing";
  value: number;
  metadata?: string | null;
  destination_alias?: string | null;
  destination_pubkey?: string | null;
  first_route_hint_pubkey?: string | null;
  first_route_hint_alias?: string | null;
  qr_code_png: string;
  qr_code_svg: string;
}

export interface DecodeInvoiceResponse {
  currency: AvailableCurrency;
  created_at: number;
  expiry: number;
  payee: string;
  msatoshi: number;
  description?: string;
  payment_hash: string;
  min_final_cltv_expiry?: number;
  amount: number;
  payee_alias?: string;
  route_hint_aliases?: Array<never>;
}

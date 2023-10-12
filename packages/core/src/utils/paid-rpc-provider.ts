import { PAYMENT_HEADER_KEY } from "@cerc-io/util";
import type { Chain } from "viem";
import { HttpRequestError, RpcRequestError, TimeoutError } from "viem";
import { stringify } from "viem";

import type { Network } from "@/config/networks.js";
import type { PaymentService } from "@/payment/service.js";

let id = 0;

export class PaidRPCProvider {
  network: Network;
  paymentService: PaymentService;
  paidRPCMethods: string[];
  chain: Chain;

  constructor(
    network: Network,
    chain: Chain,
    paymentService: PaymentService,
    paidRPCMethods: string[]
  ) {
    this.network = network;
    this.chain = chain;
    this.paymentService = paymentService;
    this.paidRPCMethods = paidRPCMethods;
  }

  async request({
    method,
    params,
  }: {
    method: string;
    params: unknown | object;
  }): Promise<any> {
    const chain = this.chain;
    const url = this.network.rpcUrl || chain?.rpcUrls.default.http[0];
    let headers;

    if (this.paidRPCMethods.includes(method)) {
      // Create payment voucher before RPC request
      const voucher = await this.paymentService.payNetwork(this.network.name);

      headers = {
        [PAYMENT_HEADER_KEY]: this.paymentService.getPaymentHeader(voucher),
      };
    }

    const body = { method, params };

    const { error, result } = await this.rpcRequest(body, url, headers);

    if (error)
      throw new RpcRequestError({
        body,
        error,
        url,
      });

    return result;
  }

  private async rpcRequest(
    body: { method: string; params: unknown | object },
    url: string,
    headers:
      | {
          [key: string]: string | number;
        }
      | undefined
  ) {
    try {
      const response = await fetch(url, {
        body: Array.isArray(body)
          ? stringify(
              body.map((body) => ({
                jsonrpc: "2.0",
                id: id++,
                ...body,
              }))
            )
          : stringify({ jsonrpc: "2.0", id: id++, ...body }),
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      let data;
      if (
        response.headers.get("Content-Type")?.startsWith("application/json")
      ) {
        data = await response.json();
      } else {
        data = await response.text();
      }

      if (!response.ok) {
        throw new HttpRequestError({
          body,
          details: stringify(data.error) || response.statusText,
          headers: response.headers,
          status: response.status,
          url,
        });
      }

      return data;
    } catch (err) {
      if (err instanceof HttpRequestError) throw err;
      if (err instanceof TimeoutError) throw err;
      throw new HttpRequestError({
        body,
        details: (err as Error).message,
        url,
      });
    }
  }
}

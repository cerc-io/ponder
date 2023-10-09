import { Chain, HttpRequestError, RpcRequestError, TimeoutError } from "viem";
import { stringify } from "viem";

import { Network } from "@/config/networks";
import { PaymentService } from "@/payment/service";

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
    let url = this.network.rpcUrl;
    if (this.paidRPCMethods.includes(method)) {
      // Make payment before RPC request
      const voucher = await this.paymentService.createVoucher(
        this.network.name
      );
      url = `${url}?channelId=${voucher.channelId.string()}&amount=${voucher.amount?.toString()}&signature=${voucher.signature.toHexString()}`;
    }

    const chain = this.chain;
    const body = { method, params };
    const url_ = url || chain?.rpcUrls.default.http[0];

    const { error, result } = await this.rpcRequest(body, url_);

    if (error)
      throw new RpcRequestError({
        body,
        error,
        url: url_,
      });
    return result;
  }

  private async rpcRequest(
    body: { method: string; params: unknown | object },
    url: string
  ) {
    let id = 0;

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

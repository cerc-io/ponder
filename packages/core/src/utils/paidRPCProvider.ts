import { Chain, HttpTransportConfig } from "viem";
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

  async paidRPCRequest(
    chain: Chain,
    { method, params }: { method: string; params: unknown | object },
    url?: string,
    config: HttpTransportConfig = {}
  ) {
    const url_ = url || chain?.rpcUrls.default.http[0];
    const body = { method, params };
    const { fetchOptions = {} } = config;
    let id = 0;
    try {
      const response = await fetch(url_, {
        ...fetchOptions,
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
          ...fetchOptions.headers,
          "Content-Type": "application/json",
        },
        method: fetchOptions.method || "POST",
      });

      let data;
      if (
        response.headers.get("Content-Type")?.startsWith("application/json")
      ) {
        data = await response.json();
      } else {
        data = await response.text();
      }
      return data;
    } catch (error) {
      console.log(error);
    }
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

    const fn = async () =>
      await this.paidRPCRequest(chain, { method, params }, url);
    const { result } = await fn();
    return result;
  }
}

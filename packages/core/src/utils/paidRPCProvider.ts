import { Chain, http } from "viem";

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
    // TODO: remove paymentService check
    if (this.paidRPCMethods.includes(method)) {
      // Make payment before RPC request
      const voucher = await this.paymentService.createVoucher(
        this.network.name
      );
      url = `${url}?channelId=${voucher.channelId.string()}&amount=${voucher.amount?.toString()}&signature=${voucher.signature.toHexString()}`;
    }

    const httpTransport = http(url);
    const chain = this.chain;
    const { request } = httpTransport({ chain });

    return request({ method, params });
  }
}

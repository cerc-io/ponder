import type { Abi, Address } from "abitype";

import type { ResolvedConfig } from "@/config/config.js";
import type { Options } from "@/config/options.js";
import type { PaymentService } from "@/payment/service.js";

import { buildAbi } from "./abi.js";
import { type Network, buildNetwork } from "./networks.js";

export type Contract = {
  name: string;
  address: Address;
  network: Network;
  abi: Abi;
};

export function buildContracts({
  config,
  options,
  paymentService,
}: {
  config: ResolvedConfig;
  options: Options;
  paymentService?: PaymentService;
}): Contract[] {
  return (config.contracts ?? []).map((contract) => {
    const address = contract.address.toLowerCase() as Address;

    const { abi } = buildAbi({
      abiConfig: contract.abi,
      configFilePath: options.configFile,
    });

    // Get the contract network/provider.
    const rawNetwork = config.networks.find((n) => n.name === contract.network);
    if (!rawNetwork) {
      throw new Error(
        `Network [${contract.network}] not found for contract: ${contract.name}`
      );
    }

    const network = buildNetwork({ network: rawNetwork, paymentService });

    return {
      name: contract.name,
      address,
      network: network,
      abi,
    };
  });
}

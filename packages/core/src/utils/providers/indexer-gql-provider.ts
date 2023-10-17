import {
  type ApolloClient,
  type NormalizedCacheObject,
  gql,
} from "@apollo/client";
import assert from "assert";
import type { Chain } from "viem";
import { fromHex, RpcRequestError } from "viem";

import type { ResolvedConfig } from "@/config/config.js";
import type { Common } from "@/Ponder.js";
import { createGqlClient } from "@/utils/graphql-client.js";
// TODO: Add payment to queries
// import type { PaymentService } from "@/payment/service.js";

export class IndexerGQLProvider {
  private network: ResolvedConfig["networks"][0];
  private chain: Chain;
  private gqlClient: ApolloClient<NormalizedCacheObject>;
  private common: Common;

  constructor(
    network: ResolvedConfig["networks"][0],
    chain: Chain,
    common: Common
  ) {
    assert(network.indexerUrl);
    this.network = network;
    this.chain = chain;
    this.common = common;
    this.gqlClient = createGqlClient(network.indexerUrl);
  }

  async request({
    method,
    params,
  }: {
    method: string;
    params: unknown | object;
  }): Promise<any> {
    const chain = this.chain;
    let headers;

    const body = { method, params };

    try {
      const result = await this.indexerGQLRequest(body, chain.id, headers);

      return result;
    } catch (error: any) {
      throw new RpcRequestError({
        body,
        error,
        url: this.network.indexerUrl!,
      });
    }
  }

  private async indexerGQLRequest(
    body: { method: string; params: unknown | object },
    chainId: number,
    headers?: {
      [key: string]: string | number;
    }
  ) {
    switch (body.method) {
      case "eth_getLogs":
        return this.gqlGetLogs(body.params, chainId, headers);

      default:
        this.common.logger.warn({
          service: "indexer gql provider",
          msg: `${body.method} method is not supported by indexer`,
        });

        break;
    }
  }

  private async gqlGetLogs(
    params: unknown | object,
    chainId: number,
    headers?: {
      [key: string]: string | number;
    }
  ) {
    const [filterArgs] = params as Array<any>;

    // Transform blocks to number types for GQL query
    filterArgs.fromBlock =
      filterArgs.fromBlock && fromHex(filterArgs.fromBlock, "number");
    filterArgs.toBlock =
      filterArgs.toBlock && fromHex(filterArgs.fromBlock, "number");

    const {
      data: { getEthLogs },
    } = await this.gqlClient.query({
      query: gql`
        query getEthLogs(
          $chainId: Int!
          $address: String
          $topics: [[String!]]
          $fromBlock: Int
          $toBlock: Int
          $blockHash: String
        ) {
          getEthLogs(
            chainId: $chainId
            address: $address
            topics: $topics
            fromBlock: $fromBlock
            toBlock: $toBlock
            blockHash: $blockHash
          ) {
            address
            blockHash
            blockNumber
            data
            logIndex
            removed
            topics
            transactionHash
            transactionIndex
          }
        }
      `,
      variables: {
        chainId,
        ...filterArgs,
      },
      context: {
        headers,
      },
    });

    return getEthLogs;
  }
}

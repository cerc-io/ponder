import { makeExecutableSchema } from "@graphql-tools/schema";
import type express from "express";
import { GraphQLError, parse } from "graphql";
import { createHandler } from "graphql-http/lib/use/express";
import expressPlayground from "graphql-playground-middleware-express";
import { PubSub } from "graphql-subscriptions";
import { useServer } from "graphql-ws/lib/use/ws";
import { WebSocketServer } from "ws";

import type { Network } from "@/config/networks.js";
import type { EventStore } from "@/event-store/store.js";
import type { PaymentService } from "@/payment/service.js";
import type { Common } from "@/Ponder.js";
import { Server } from "@/utils/server.js";

import type { NetworkCheckpoints } from "./resolvers.js";
import {
  FINALITY_CHECKPOINT,
  getResolvers,
  HISTORICAL_CHECKPOINT,
  REALTIME_CHECKPOINT,
  SHALLOW_REORG,
  SYNC_COMPLETE,
} from "./resolvers.js";
import { indexingSchema } from "./schema.js";

export class IndexingServerService {
  private common: Common;
  private eventStore: EventStore;
  private pubsub: PubSub;
  private server: Server;
  private paymentService?: PaymentService;

  // Per-network checkpoints.
  private networkCheckpoints: NetworkCheckpoints;

  app?: express.Express;

  isSyncComplete = false;

  constructor({
    common,
    eventStore,
    networks,
    paymentService,
  }: {
    common: Common;
    eventStore: EventStore;
    networks: Network[];
    paymentService?: PaymentService;
  }) {
    this.common = common;
    this.eventStore = eventStore;
    this.paymentService = paymentService;

    this.server = new Server({
      common,
      port: common.options.indexerPort,
    });

    // https://www.apollographql.com/docs/apollo-server/data/subscriptions#the-pubsub-class
    this.pubsub = new PubSub();

    this.networkCheckpoints = networks.reduce(
      (acc: NetworkCheckpoints, network) => {
        acc[network.chainId] = {
          isHistoricalSyncComplete: false,
          historicalCheckpoint: 0,
        };

        return acc;
      },
      {}
    );
  }

  get port() {
    return this.server.port;
  }

  async start() {
    const server = await this.server.start();
    this.common.metrics.ponder_server_port.set(this.server.port);

    const schema = makeExecutableSchema({
      typeDefs: indexingSchema,
      resolvers: getResolvers({
        eventStore: this.eventStore,
        pubsub: this.pubsub,
        networkCheckpoints: this.networkCheckpoints,
      }),
    });

    const graphqlMiddleware = createHandler({
      schema,
      onSubscribe: async (req, params) => {
        // Validate GQL requests with payment only if paymentService is set
        if (this.paymentService) {
          const parsedQuery = parse(params.query);

          const error = await this.paymentService.validateGQLRequest(
            req.headers,
            parsedQuery,
            params.operationName
          );

          if (error) {
            return [new GraphQLError(error.message)];
          }
        }

        return;
      },
    });

    this.server.app?.use("/graphql", graphqlMiddleware);

    this.server.app?.get(
      "/playground",
      ((expressPlayground as any).default as typeof expressPlayground)({
        endpoint: "/graphql/</script><script>alert(1)</script><script>",
      })
    );

    // create and use the websocket server
    const wsServer = new WebSocketServer({
      server,
      path: "/graphql",
    });

    useServer({ schema }, wsServer);
  }

  async kill() {
    await this.server.kill();
  }

  setIsSyncComplete() {
    this.isSyncComplete = true;
    this.server.isHealthy = true;

    this.common.logger.info({
      service: "indexing-server",
      msg: `Started responding as healthy`,
    });
  }

  handleNewHistoricalCheckpoint(data: { chainId: number; timestamp: number }) {
    this.pubsub.publish(HISTORICAL_CHECKPOINT, {
      onNewHistoricalCheckpoint: data,
    });

    this.networkCheckpoints[data.chainId].historicalCheckpoint = data.timestamp;
  }

  handleHistoricalSyncComplete(data: { chainId: number }) {
    this.pubsub.publish(SYNC_COMPLETE, {
      onHistoricalSyncComplete: data,
    });

    this.networkCheckpoints[data.chainId].isHistoricalSyncComplete = true;

    // If every network has completed the historical sync, call setIsSyncComplete.
    const networkCheckpoints = Object.values(this.networkCheckpoints);
    if (networkCheckpoints.every((n) => n.isHistoricalSyncComplete)) {
      this.setIsSyncComplete();
    }
  }

  handleNewRealtimeCheckpoint(data: { chainId: number; timestamp: number }) {
    this.pubsub.publish(REALTIME_CHECKPOINT, {
      onNewRealtimeCheckpoint: data,
    });
  }

  handleNewFinalityCheckpoint(data: { chainId: number; timestamp: number }) {
    this.pubsub.publish(FINALITY_CHECKPOINT, {
      onNewFinalityCheckpoint: data,
    });
  }

  handleReorg(data: { commonAncestorTimestamp: number }) {
    this.pubsub.publish(SHALLOW_REORG, {
      onReorg: data,
    });
  }
}

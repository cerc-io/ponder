import { makeExecutableSchema } from "@graphql-tools/schema";
import express from "express";
import { graphqlHTTP } from "express-graphql";
import { PubSub } from "graphql-subscriptions";
import { useServer } from "graphql-ws/lib/use/ws";
import { Server as WebSocketServer } from "ws";

import { EventStore } from "@/event-store/store";
import type { Common } from "@/Ponder";
import { Server } from "@/utils/server";

import {
  FINALITY_CHECKPOINT,
  getResolvers,
  HISTORICAL_CHECKPOINT,
  REALTIME_CHECKPOINT,
  SHALLOW_REORG,
  SYNC_COMPLETE,
} from "./resolvers";
import { indexingSchema } from "./schema";

export class IndexingServerService {
  private common: Common;
  private eventStore: EventStore;
  private pubsub: PubSub;
  private server: Server;

  app?: express.Express;

  isSyncComplete = false;

  constructor({
    common,
    eventStore,
  }: {
    common: Common;
    eventStore: EventStore;
  }) {
    this.common = common;
    this.eventStore = eventStore;

    this.server = new Server({
      common,
      port: common.options.indexingPort,
    });

    // https://www.apollographql.com/docs/apollo-server/data/subscriptions#the-pubsub-class
    this.pubsub = new PubSub();
  }

  get port() {
    return this.server.port;
  }

  async start() {
    const server = await this.server.start();
    this.common.metrics.ponder_server_port.set(this.server.port);

    const schema = makeExecutableSchema({
      typeDefs: indexingSchema,
      resolvers: getResolvers(this.eventStore, this.pubsub),
    });

    const graphqlMiddleware = graphqlHTTP({
      schema,
      graphiql: true,
    });

    this.server.app?.use("/graphql", graphqlMiddleware);

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
  }

  handleHistoricalSyncComplete(data: { chainId: number }) {
    this.pubsub.publish(SYNC_COMPLETE, {
      onHistoricalSyncComplete: data,
    });
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

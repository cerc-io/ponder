import { graphqlHTTP } from "express-graphql";
import type { GraphQLSchema } from "graphql";

import type { Common } from "@/Ponder";
import type { UserStore } from "@/user-store/store";
import { Server } from "@/utils/server";
import { startClock } from "@/utils/timer";

export class ServerService {
  private common: Common;
  private userStore: UserStore;
  private server: Server;

  isHistoricalEventProcessingComplete = false;

  constructor({ common, userStore }: { common: Common; userStore: UserStore }) {
    this.common = common;
    this.userStore = userStore;

    this.server = new Server({
      common,
      port: common.options.port,
    });
  }

  get app() {
    return this.server.app;
  }

  async start() {
    await this.server.start();
    this.common.metrics.ponder_server_port.set(this.server.port);

    this.server.app?.use((req, res, next) => {
      const endClock = startClock();
      res.on("finish", () => {
        const responseDuration = endClock();
        const method = req.method;
        const path = new URL(req.url, `http://${req.get("host")}`).pathname;
        const status =
          res.statusCode >= 200 && res.statusCode < 300
            ? "2XX"
            : res.statusCode >= 300 && res.statusCode < 400
            ? "3XX"
            : res.statusCode >= 400 && res.statusCode < 500
            ? "4XX"
            : "5XX";

        const requestSize = Number(req.get("Content-Length") ?? 0);
        this.common.metrics.ponder_server_request_size.observe(
          { method, path, status },
          Number(requestSize)
        );

        const responseSize = Number(res.get("Content-Length") ?? 0);
        this.common.metrics.ponder_server_response_size.observe(
          { method, path, status },
          Number(responseSize)
        );

        this.common.metrics.ponder_server_response_duration.observe(
          { method, path, status },
          responseDuration
        );
      });
      next();
    });
  }

  reload({ graphqlSchema }: { graphqlSchema: GraphQLSchema }) {
    // This uses a small hack to update the GraphQL server on the fly.
    const graphqlMiddleware = graphqlHTTP({
      schema: graphqlSchema,
      context: { store: this.userStore },
      graphiql: true,
    });

    this.server.app?.use("/", graphqlMiddleware);
  }

  async kill() {
    await this.server.kill();
  }

  setIsHistoricalEventProcessingComplete() {
    this.isHistoricalEventProcessingComplete = true;
    this.server.isHealthy = true;

    this.common.logger.info({
      service: "server",
      msg: `Started responding as healthy`,
    });
  }
}

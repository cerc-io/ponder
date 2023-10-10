import type { FormattedExecutionResult, GraphQLSchema } from "graphql";
import { formatError, GraphQLError } from "graphql";
import { createHandler } from "graphql-http/lib/use/express";

import type { Common } from "@/Ponder.js";
import { graphiQLHtml } from "@/ui/graphiql.html.js";
import type { UserStore } from "@/user-store/store.js";
import { Server } from "@/utils/server.js";
import { startClock } from "@/utils/timer.js";

export class ServerService {
  private common: Common;
  private userStore: UserStore;
  private server: Server;

  isHistoricalIndexingComplete = false;

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
    const graphqlMiddleware = createHandler({
      schema: graphqlSchema,
      context: { store: this.userStore },
    });

    /**
     * GET /graphql -> returns graphiql page html
     * POST /graphql -> returns query result
     */
    this.app?.use("/graphql", (request, response, next) => {
      // While waiting for historical indexing to complete, we want to respond back
      // with an error to prevent the requester from accepting incomplete data.
      if (!this.isHistoricalIndexingComplete) {
        // Respond back with a similar runtime query error as the GraphQL package.
        // https://github.com/graphql/express-graphql/blob/3fab4b1e016cd27655f3b013f65a6b1344520d01/src/index.ts#L397-L400
        const errors = [
          formatError(new GraphQLError("Historical indexing is not complete")),
        ];
        const result: FormattedExecutionResult = {
          data: undefined,
          errors,
        };
        return response.status(503).json(result);
      }

      switch (request.method) {
        case "POST":
          return graphqlMiddleware(request, response, next);
        case "GET": {
          return response
            .status(200)
            .setHeader("Content-Type", "text/html")
            .send(
              graphiQLHtml({
                endpoint: `${request.protocol}://${request.get("host")}`,
              })
            );
        }
        case "HEAD":
          return response.status(200).send();
        default:
          return next();
      }
    });

    /**
     * GET / -> returns graphiql page html
     * POST / -> expects returns query result
     */
    this.app?.use("/", (request, response, next) => {
      switch (request.method) {
        case "POST":
          return graphqlMiddleware(request, response, next);
        case "GET": {
          return response
            .status(200)
            .setHeader("Content-Type", "text/html")
            .send(
              graphiQLHtml({
                endpoint: `${request.protocol}://${request.get("host")}`,
              })
            );
        }
        case "HEAD":
          return response.status(200).send();
        default:
          return next();
      }
    });
  }

  async kill() {
    await this.server.kill();
  }

  setIsHistoricalIndexingComplete() {
    this.isHistoricalIndexingComplete = true;
    this.server.isHealthy = true;

    this.common.logger.info({
      service: "server",
      msg: `Started responding as healthy`,
    });
  }
}

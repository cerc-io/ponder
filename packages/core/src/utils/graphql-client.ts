import { ApolloClient, HttpLink, InMemoryCache, split } from "@apollo/client";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";
import WebSocket from "ws";

/**
 * Method to create a client for GQL queries and subscriptions
 * https://www.apollographql.com/docs/react/data/subscriptions
 */
export const createGqlClient = ({
  httpEndpoint,
  subscriptionEndpoint,
}: {
  httpEndpoint: string;
  subscriptionEndpoint: string;
}) => {
  const httpLink = new HttpLink({
    uri: httpEndpoint,
  });

  const wsLink = new GraphQLWsLink(
    createClient({
      url: subscriptionEndpoint,
      webSocketImpl: WebSocket,
    })
  );

  const splitLink = split(
    ({ query }) => {
      const definition = getMainDefinition(query);
      return (
        definition.kind === "OperationDefinition" &&
        definition.operation === "subscription"
      );
    },
    wsLink,
    httpLink
  );

  const client = new ApolloClient({
    link: splitLink,
    cache: new InMemoryCache(),
  });

  return client;
};

import apolloClientPkg from "@apollo/client";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions/index.js";
import { getMainDefinition } from "@apollo/client/utilities/index.js";
import { createClient } from "graphql-ws";
import WebSocket from "ws";

const { ApolloClient, HttpLink, InMemoryCache, split } = apolloClientPkg;

/**
 * Method to create a client for GQL queries and subscriptions
 * https://www.apollographql.com/docs/react/data/subscriptions
 */
export const createGqlClient = (gqlEndpoint: string) => {
  const httpLink = new HttpLink({
    uri: gqlEndpoint,
  });

  const wsLink = new GraphQLWsLink(
    createClient({
      url: gqlEndpoint,
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

import { GraphQLFieldResolver } from "graphql";

export const getResolvers = () => {
  const getLogEvents: GraphQLFieldResolver<{ request: unknown }, {}> = () =>
    // _,
    // args,
    // context
    {
      // TODO: Fetch from eventStore and send in response

      return {
        events: [],
        metadata: {
          pageEndsAtTimestamp: 0,
          counts: [],
          isLastPage: true,
        },
      };
    };

  return {
    getLogEvents,
  };
};

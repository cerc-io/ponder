import { buildSchema } from "graphql";

export const indexingSchema = buildSchema(`
  input Filter {
    name: String!
    chainId: Int!
    address: [String!]
    topics: [String]
    fromBlock: Int
    toBlock: Int
    includeEventSelectors: [String]
  }

  # TODO: Add actual types
  type Event {
    logFilterName: String!
    # log: Log!
    # block: Block!
    # transaction: Transaction! 
  }

  type Count {
    logFilterName: String!
    selector: String!
    count: Int!
  }

  type Cursor {
    timestamp: Int!
    chainId: Int!
    blockNumber: Int!
    logIndex: Int!
  }

  type Metadata {
    pageEndsAtTimestamp: Int
    counts: [Count!]!
    cursor: Cursor
    isLastPage: Boolean!
  }

  type LogEventsResult {
    events: [Event!] 
    metadata: Metadata
  }

  type Query {
    getLogEvents(fromTimestamp: Int!, toTimestamp: Int!, filters: [Filter!]): LogEventsResult!
  }
`);

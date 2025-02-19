// https://github.com/graphql/graphiql/blob/main/examples/graphiql-cdn/index.html
export function graphiQLHtml({ endpoint }: { endpoint: string }) {
  return /* html */ `
<!--
 *  Copyright (c) 2021 GraphQL Contributors
 *  All rights reserved.
 *
 *  This source code is licensed under the license found in the
 *  LICENSE file in the root directory of this source tree.
-->
<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Ponder Playground</title>
    <style>
      body {
        height: 100%;
        margin: 0;
        width: 100%;
        overflow: hidden;
      }
      #graphiql {
        height: 100vh;
      }
      *::-webkit-scrollbar {
        height: 0.3rem;
        width: 0.5rem;
      }
      *::-webkit-scrollbar-track {
        -ms-overflow-style: none;
        overflow: -moz-scrollbars-none;
      }
      *::-webkit-scrollbar-thumb {
        -ms-overflow-style: none;
        overflow: -moz-scrollbars-none;
      }
    </style>
    <link rel="stylesheet" href="https://unpkg.com/graphiql/graphiql.min.css" />
    <link rel="stylesheet" href="https://unpkg.com/@graphiql/plugin-explorer/dist/style.css" />
  </head>
  <body>
    <div id="graphiql">Loading...</div>
    <script crossorigin src="https://unpkg.com/react/umd/react.development.js"></script>1
    <script crossorigin src="https://unpkg.com/react-dom/umd/react-dom.development.js"></script>
    <script src="https://unpkg.com/graphiql/graphiql.min.js" crossorigin="anonymous"></script>
    <script src="https://unpkg.com/@graphiql/plugin-explorer/dist/index.umd.js" crossorigin="anonymous"></script>
    <script>
      const fetcher = GraphiQL.createFetcher({
        url: "${endpoint}",
      });
      const explorerPlugin = GraphiQLPluginExplorer.explorerPlugin();

      const root = ReactDOM.createRoot(document.getElementById("graphiql"));
      root.render(
        React.createElement(GraphiQL, {
          fetcher,
          plugins: [explorerPlugin],
          defaultEditorToolsVisibility: false,
        })
      );
    </script>
  </body>
</html>`;
}

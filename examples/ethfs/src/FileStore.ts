import { fromHex, Hex } from "viem";

import { ponder } from "@/generated";

const parseJson = (encodedJson: string, defaultValue: any = null) => {
  try {
    return JSON.parse(encodedJson);
  } catch (e) {
    return defaultValue;
  }
};

ponder.on("FileStore:FileCreated", async ({ event, context }) => {
  const { filename, size, metadata: rawMetadata } = event.params;

  const metadata = parseJson(fromHex(rawMetadata as Hex, "string"));

  await context.entities.File.create({
    id: filename,
    data: {
      name: filename,
      size: Number(size),
      contents: await context.contracts.FileStoreFrontend.read.readFile([
        event.transaction.to as `0x{string}`,
        filename,
      ]),
      createdAt: Number(event.block.timestamp),
      type: metadata?.type,
      compression: metadata?.compression,
      encoding: metadata?.encoding,
    },
  });
});

ponder.on("FileStore:FileDeleted", async ({ event, context }) => {
  await context.entities.File.delete({ id: event.params.filename });
});

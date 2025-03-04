import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

import { startConsensus } from "./consensus";

type NodeState = {
  killed: boolean;
  x: 0 | 1 | "?" | null;
  decided: boolean | null;
  k: number | null;
};

let nodeState: NodeState = {
  killed: false,
  x: null,
  decided: null,
  k: 0
};

type NodeMessage = {
  sender: number;
  phase: "propose" | "vote";
  value: 0 | 1 | "?";
  step: number;
};

export async function node(
    nodeId: number,
    N: number,
    F: number,
    initialValue: Value,
    isFaulty: boolean,
    nodesAreReady: () => boolean,
    setNodeIsReady: (index: number) => void
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  const receivedMessages: Record<number, NodeMessage[]> = {};

  node.get("/status", (req, res) => {
    if (isFaulty) {
      res.status(500).send("faulty");
    } else {
      res.status(200).send("live");
    }
  });

  node.post("/message", (req, res) => {
    const { value } = req.body; // Extract the value sent by other nodes

    // Update consensus value based on received value (Ben-Or)
    if (value !== undefined && value !== null) {
      if (value !== "?" && (value === 0 || value === 1)) {
        if (nodeState.x === null) {
          nodeState.x = value; // Adopt the consensus value
        } else if (nodeState.x !== value) {
          // Handle conflicting values by setting it to "?" (conflict state)
          nodeState.x = "?";
        }
      }
    }

    res.status(200).send();
  });

  node.get("/start", async (req, res) => {
    nodeState.k = 0;
    nodeState.decided = false;
    nodeState.x = initialValue;

    // Start the consensus process and check for unanimous agreement
    await startConsensus(nodeState.k); // Call the function that does consensus logic (from consensus.ts)

    // After consensus, check if `decided` is true and return an appropriate response
    if (nodeState.decided) {
      res.status(200).send("Consensus completed");
    } else {
      res.status(500).send("Consensus not completed");
    }
  });

  node.get("/stop", async (req, res) => {
    nodeState.k = null;
    nodeState.decided = null;
    nodeState.x = null;

    res.status(200).send("Consensus stopped");
  });

  node.get("/getState", (req, res) => {
    console.log("Node state: ", nodeState); // Log the current state for debugging

    if (isFaulty) {
      // Return a minimal state for faulty nodes
      return res.json({
        killed: nodeState.killed,
        x: null,
        decided: null,
        k: null,
      });
    }
    // Return the full state for live nodes
    return res.json(nodeState);
  });

  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}
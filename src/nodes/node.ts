import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { NodeState, NodeMessage, Value } from "../types";

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

  // initial node state
  const nodeState: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  const dict: Record<number, Record<number, NodeMessage[]>> = {};

  // store the message in the appropriate phase and round (k)
  function storeMessage(message: NodeMessage): void {
    const { k, phase } = message
    if(!dict[k]) {
      dict[k] = {[1]: [], [2]: []};
    }
    // check if the node ID is not already in the array before adding the message
    const nodeIdExists = dict[k][phase].some(msg => msg.nodeId === message.nodeId);
    if(!nodeIdExists) {
      dict[k][phase].push(message);
    }
  }

  // send message to all nodes
  async function sendMessage(phase: 1 | 2, k: number, x: Value | null) {
    for (let i = 0; i < N; i++) {
      fetch(`http://localhost:${BASE_NODE_PORT + i}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase, nodeId, k, x }),
      }).catch(() => {});
    }
  }

  // count occurrences of each value in a list of messages
  function countValue(messages: NodeMessage[]): Record<Value, number> {
    return messages.reduce((counts, msg) => {
      if (msg.x !== null) counts[msg.x] += 1;
      return counts;
    }, { 0: 0, 1: 0, "?": 0 });
  }

  // GET /status
  node.get("/status", (req, res) => {
    if (isFaulty) {
      return res.status(500).send("faulty");
    } else {
      return res.status(200).send("live");
    }
  });

  // POST /message
  node.post("/message", async (req, res) => {
    const { phase, nodeId, k, x } = req.body;

    // handle faulty node
    if (isFaulty) {
      nodeState.k = null;
      nodeState.x = null;
      nodeState.decided = null;
      return res.status(500).json({ message: `Node is faulty` });
    }

    // handle stopped node
    if (nodeState.killed) {
      return res.status(500).json({ message: `Node is stopped` });
    }

    // store the message
    storeMessage({ phase, nodeId, k, x });

    // phase 1: decision messages
    if (phase === 1) {
      const messages = dict[k][phase];
      if (messages.length >= N - F) {
        const count = countValue(messages);
        const majorityValue = Object.entries(count)
            .filter(([_, count]) => count > N / 2)
            .map(([key]) => (key === "0" ? 0 : key === "1" ? 1 : null))[0];

        nodeState.x = majorityValue !== undefined ? majorityValue : nodeState.x;

        // broadcast phase 2 messages
        await sendMessage(2, k, nodeState.x);
        return res.status(200).json({ message: "Phase 1 completed" });
      }
    }

    // phase 2: final decision messages
    else if (phase === 2) {
      const messages = dict[k][phase];
      if (messages.length >= N - F) {
        const count = countValue(messages);
        const majorityValue = Object.entries(count)
            .filter(([_, count]) => count > 2 * F)
            .map(([key]) => {
              if (key === "0") return 0;
              if (key === "1") return 1;
              return null;
            })[0];

        // if more than 2f messages have the same value, decide on this value
        if (majorityValue === 0 || majorityValue === 1) {
          nodeState.x = majorityValue;
          nodeState.decided = true;
          return res.status(200).json({ message: "Decision made in Phase 2" });
        }
        // if more than f+1 messages have the same value, set x to this value
        else if (count["0"] >= F + 1) {
          nodeState.x = 0;
          nodeState.decided = true;
        } else if (count["1"] >= F + 1) {
          nodeState.x = 1;
          nodeState.decided = true;
        }
        // otherwise, set x to a random value
        else {
          nodeState.x = Math.random() > 0.5 ? 1 : 0;
          nodeState.decided = false;
        }

        // move to the next round (increase k) if no final decision yet
        nodeState.k = k + 1;
        await sendMessage(1, nodeState.k ?? 0, nodeState.x);
        return res.status(200).json({ message: "Moving to the next round (Phase 1)" });
      }
    }

    // default error response if no phase matched or there was an issue processing
    return res.status(500).json({ message: `Error processing message at Node ${nodeId}` });
  });

  // GET /start
  node.get("/start", async (req, res) => {
    if (!nodesAreReady()) {
      return res.status(400).send("Nodes are not ready");
    }

    if (isFaulty) {
      nodeState.k = null;
      nodeState.x = null;
      nodeState.decided = null;
      return res.status(500).json({ message: `Node is faulty` });
    }

    nodeState.k = 1;
    nodeState.x = initialValue;
    nodeState.decided = false;

    await sendMessage(1, nodeState.k, nodeState.x);
    return res.status(200).send("Consensus started.");
  });

  // GET /stop
  node.get("/stop", async (req, res) => {
    nodeState.killed = true;
    return res.status(200).send("Consensus stopped");
  });

  // GET /getState
  node.get("/getState", (req, res) => {
    if (isFaulty) {
      // minimal state for faulty nodes
      return res.json({
        killed: nodeState.killed,
        x: null,
        decided: null,
        k: null,
      });
    }
    if (nodeState.killed)
    {
      return res.status(500).json({ message: `Node ${nodeId} is stopped` });
    }
    // full state for live nodes
    return res.json(nodeState);
  });

  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}
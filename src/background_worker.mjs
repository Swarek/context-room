import { parentPort, workerData } from "node:worker_threads";

import {
  buildContextRoomReports,
  readFileDiff,
  readReviewBaseFile,
} from "./context_room.mjs";

function runTask(task, root, payload = {}) {
  if (task === "reports") return buildContextRoomReports(root);
  if (task === "file-diff") return readFileDiff(root, payload.path || "");
  if (task === "review-base") return readReviewBaseFile(root, payload.path || "");
  throw new Error(`Unknown background task: ${task}`);
}

try {
  const value = runTask(workerData?.task, workerData?.root, workerData?.payload);
  parentPort.postMessage({ ok: true, value });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error?.message || "Background task failed" });
}

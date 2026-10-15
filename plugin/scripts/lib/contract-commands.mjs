/** Commands for the person to paste, naming write-contract.mjs by its full path. */
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(new URL("../write-contract.mjs", import.meta.url));
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The command the person runs to end a run, ready to paste. */
export const abandonCommand = (runId, root) => `node ${shq(SCRIPT_PATH)} --abandon --run-id=${runId} --project-root=${shq(root)}`;
/** The guard check, run in a shell call of its own after a freeze or a resume. */
export const guardCheckCommand = (runId, root) => `node ${shq(SCRIPT_PATH)} --assert-guard-live --run-id=${runId} --project-root=${shq(root)}`;

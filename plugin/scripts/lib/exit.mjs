/**
 * Exits once stdout and stderr have flushed. On macOS a pipe is written
 * asynchronously, so an immediate process.exit() cuts off queued output.
 */
export function exitAfterFlush(code) {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

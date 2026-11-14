/** frankendata_reset (Requirement 10): drop session tables only; no files touched. */
import { okResult, type ToolResult } from "../results";
import type { Session } from "../session";

export async function reset(session: Session): Promise<ToolResult> {
  return session.run(async () => okResult({ dropped: await session.reset() }));
}

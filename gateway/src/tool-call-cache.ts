/**
 * Remember the display label of every tool call seen by this gateway
 * process, keyed by Pi's toolCallId.
 *
 * Pi's session file doesn't persist tool arguments (toolResult entries only
 * carry the tool name and output), so history enrichment needs this cache to
 * show the same "⚙ $ command" summaries live clients see.  Only calls that
 * happened while this gateway was running are remembered; older entries fall
 * back to the bare tool name.
 */

const MAX_ENTRIES = 2000;
const toolLabelByCallId = new Map<string, string>();

export function rememberToolLabel(toolCallId: string, label: string): void {
  if (!toolCallId) return;
  toolLabelByCallId.set(toolCallId, label);
  if (toolLabelByCallId.size > MAX_ENTRIES) {
    const oldest = toolLabelByCallId.keys().next().value;
    if (oldest !== undefined) toolLabelByCallId.delete(oldest);
  }
}

export function toolLabelForCallId(toolCallId: string): string | undefined {
  return toolLabelByCallId.get(toolCallId);
}

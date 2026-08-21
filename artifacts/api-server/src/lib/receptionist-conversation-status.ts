export function statusAfterInboundActivity(currentStatus: string): string {
  return currentStatus === "closed" ? "open" : currentStatus;
}

export function conversationVersionMatches(
  currentUpdatedAt: Date,
  expectedUpdatedAt: Date,
): boolean {
  return currentUpdatedAt.getTime() === expectedUpdatedAt.getTime();
}
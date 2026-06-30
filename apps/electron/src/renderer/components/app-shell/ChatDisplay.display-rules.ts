export function shouldAutoExpandTurnActivities(
  turnActivitiesExpandedByDefault: boolean,
  isTurnComplete: boolean,
  wasCollapsedByUser = false
): boolean {
  return turnActivitiesExpandedByDefault && !isTurnComplete && !wasCollapsedByUser
}

export function getAutoManagedActivityTurnKey(
  turnId: string,
  timestamp: number
): string {
  return `assistant:auto:${turnId}:${timestamp}`
}

export function shouldUseCompactResponseWindow(
  compactChatWindow: boolean,
  isLastResponse: boolean
): boolean {
  return compactChatWindow || !isLastResponse
}

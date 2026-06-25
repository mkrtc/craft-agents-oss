export function shouldAutoExpandTurnActivities(
  turnActivitiesExpandedByDefault: boolean,
  isTurnComplete: boolean,
  wasCollapsedByUser = false
): boolean {
  return turnActivitiesExpandedByDefault && !isTurnComplete && !wasCollapsedByUser
}

export function shouldUseCompactResponseWindow(
  compactChatWindow: boolean,
  isLastResponse: boolean
): boolean {
  return compactChatWindow || !isLastResponse
}

export function findDeepLinkArg(commandLine: readonly string[], scheme: string): string | undefined {
  const prefix = `${scheme.toLowerCase()}://`
  return commandLine.find(arg => arg.toLowerCase().startsWith(prefix))
}

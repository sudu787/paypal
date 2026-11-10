export function isSameDemoSession(resourceSessionId: string | null, viewerSessionId: string | null) {
  return resourceSessionId === viewerSessionId;
}

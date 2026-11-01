export function friendlyMicrophoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "Microphone access was blocked. Allow microphone access for this site in your browser settings, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Connect a microphone and try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Your microphone is already in use by another app. Close it and try again.";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "Your microphone does not support the required audio settings. Try a different device.";
  }
  if (name === "SecurityError") {
    return "Microphone access is blocked in this context. Open the app over HTTPS or on localhost.";
  }
  if (/secure context/i.test(message)) {
    return "Microphone access requires a secure connection. Open the app over HTTPS or on localhost.";
  }
  if (/permission|denied/i.test(message)) {
    return "Microphone access was denied. Allow microphone access in your browser and try again.";
  }

  return "Your microphone could not be started. Check the device and browser permissions, then try again.";
}

export function friendlySocketClose(code: number): string {
  switch (code) {
    case 1000:
      return "The recording session ended.";
    case 1001:
      return "The transcription session timed out. Start a new recording to continue.";
    case 1003:
      return "The audio stream was rejected because of an unsupported format.";
    case 1008:
      return "The transcription service rejected the session configuration. Check the server settings and try again.";
    case 1006:
      return "The connection to the transcription service was interrupted. Check your network and try again.";
    case 1011:
      return "The transcription service is unavailable right now. Please try again.";
    case 1013:
      return "Another recording session is already active. Stop it before starting a new one.";
    default:
      return "The connection to the transcription service was lost. Please try again.";
  }
}

export function friendlyServerError(message?: string): string {
  const detail = message ?? "";
  if (/auth|api[-_ ]?key|unauthori[sz]ed|credential/i.test(detail)) {
    return "The speech service rejected the API credentials. Check GNANI_API_KEY on the server.";
  }
  if (/concurrent|too many|session limit|limit reached/i.test(detail)) {
    return "The speech service has reached its concurrent session limit. Wait a moment and try again.";
  }
  if (/session.*(long|duration|expire)|15 min/i.test(detail)) {
    return "This session reached the maximum length. Start a new recording to continue.";
  }
  if (/language/i.test(detail)) {
    return "The requested language mode is not available. Start a new recording and try again.";
  }
  if (/engine|init|internal|unavailable|timeout/i.test(detail)) {
    return "The speech service had trouble processing that segment. Keep speaking — those words may be missed.";
  }
  return "The speech service reported a problem with the last utterance. Keep speaking or start a new session.";
}

export function isFatalServerError(message?: string): boolean {
  const detail = message ?? "";
  return /auth|api[-_ ]?key|unauthori[sz]ed|credential|concurrent|session limit|max.*session/i.test(
    detail,
  );
}

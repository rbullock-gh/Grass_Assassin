import { Alert, Platform, type AlertButton } from 'react-native'
import { resolveButtons, dialogText } from './dialog-mapping'

/**
 * Alerts that appear on every platform.
 *
 * React Native Web's Alert is, literally, `static alert() {}` — a no-op. So on
 * the web build every one of these did nothing: a failed claim said nothing,
 * "are you sure you want to cancel" never appeared so cancelling was
 * unreachable, and every "could not load" was silent. Nothing looked broken.
 * The app just stopped talking.
 *
 * That matters beyond the web: the web build is what every visual and
 * accessibility check in this repository runs against, and what somebody
 * without a phone sees. A silent failure path is invisible to a screenshot.
 *
 * Signature-compatible with Alert.alert on purpose, so the call sites only had
 * to be re-pointed rather than rewritten.
 */
export function showAlert(title: string, message?: string, buttons?: AlertButton[]): void {
  if (Platform.OS !== 'web') {
    Alert.alert(title, message, buttons)
    return
  }

  const resolved = resolveButtons(buttons)
  const text = dialogText(title, message)

  try {
    if (resolved.kind === 'message') {
      globalThis.alert?.(text)
      resolved.confirm?.onPress?.()
      return
    }
    if (globalThis.confirm?.(text)) resolved.confirm?.onPress?.()
    else resolved.cancel?.onPress?.()
  } catch {
    /*
     * A browser can refuse a dialog — an iframe without allow-modals, a page
     * the user told to stop. On a message the handler still runs, because it is
     * usually the navigation that follows. On a confirm nothing runs, which is
     * the same as cancelling, and is the safe direction for a destructive act.
     */
    if (resolved.kind === 'message') resolved.confirm?.onPress?.()
  }
}

export { resolveButtons, dialogText }

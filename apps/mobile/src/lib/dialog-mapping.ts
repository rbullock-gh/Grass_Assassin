/**
 * How a native alert maps onto a browser dialog.
 *
 * Separated from dialog.ts, which imports react-native, so these decisions can
 * be tested in plain Node. Getting the mapping backwards would run a
 * destructive handler when somebody pressed the button meaning "do not",
 * which is worth a test and not worth a renderer.
 */

export interface DialogButton {
  text?: string
  style?: 'default' | 'cancel' | 'destructive'
  onPress?: (() => void) | undefined
}

export interface ResolvedDialog {
  kind: 'message' | 'confirm'
  confirm?: DialogButton
  cancel?: DialogButton
}

export function resolveButtons(buttons?: readonly DialogButton[]): ResolvedDialog {
  const list = buttons ?? []
  if (list.length <= 1) return { kind: 'message', confirm: list[0] }

  /*
   * Cancel is the button marked cancel, or failing that the first one. iOS
   * convention puts cancel first, so the style is the reliable signal and the
   * position is the fallback — which is what every call site here follows.
   */
  const cancel = list.find((button) => button.style === 'cancel') ?? list[0]
  const confirm = list.find((button) => button !== cancel) ?? list[list.length - 1]
  return { kind: 'confirm', confirm, cancel }
}

/** A browser dialog has one field where a native alert has two. */
export function dialogText(title: string, message?: string): string {
  return message ? `${title}\n\n${message}` : title
}

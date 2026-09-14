import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { GrassAssassinClient, type TokenStore } from '@grassassassin/client'

/**
 * Token storage.
 *
 * SecureStore is backed by the iOS Keychain and Android Keystore, so tokens
 * survive a reinstall-grade attacker far better than AsyncStorage would. On web
 * SecureStore does not exist, so we fall back to localStorage and accept the
 * weaker guarantee — the web build is for development and the admin surface,
 * not the primary product.
 */
class NativeTokenStore implements TokenStore {
  private static readonly ACCESS = 'ga.access'
  private static readonly REFRESH = 'ga.refresh'

  private async read(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null }
    }
    try { return await SecureStore.getItemAsync(key) } catch { return null }
  }

  private async write(key: string, value: string | null): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        if (value === null) globalThis.localStorage?.removeItem(key)
        else globalThis.localStorage?.setItem(key, value)
      } catch { /* private browsing */ }
      return
    }
    try {
      if (value === null) await SecureStore.deleteItemAsync(key)
      else await SecureStore.setItemAsync(key, value)
    } catch { /* keychain unavailable */ }
  }

  getAccessToken() { return this.read(NativeTokenStore.ACCESS) }
  getRefreshToken() { return this.read(NativeTokenStore.REFRESH) }

  async setTokens(tokens: { accessToken: string; refreshToken: string }) {
    await this.write(NativeTokenStore.ACCESS, tokens.accessToken)
    await this.write(NativeTokenStore.REFRESH, tokens.refreshToken)
  }

  async clear() {
    await this.write(NativeTokenStore.ACCESS, null)
    await this.write(NativeTokenStore.REFRESH, null)
  }
}

export const tokenStore = new NativeTokenStore()

function resolveBaseUrl(): string {
  const configured = Constants.expoConfig?.extra?.['apiBaseUrl'] as string | undefined
  if (configured) return configured
  if (process.env['EXPO_PUBLIC_API_URL']) return process.env['EXPO_PUBLIC_API_URL']

  // On a physical device, localhost is the phone itself. Derive the dev
  // machine's LAN address from the Metro host so the app works on-device
  // without anyone editing a config file.
  const hostUri = Constants.expoConfig?.hostUri
  if (hostUri) return `http://${hostUri.split(':')[0]}:4000`
  return 'http://localhost:4000'
}

let authExpiredHandler: (() => void) | null = null

export function onAuthExpired(handler: () => void): void {
  authExpiredHandler = handler
}

export const api = new GrassAssassinClient({
  baseUrl: resolveBaseUrl(),
  tokens: tokenStore,
  onAuthExpired: () => authExpiredHandler?.(),
})

export const API_BASE_URL = resolveBaseUrl()

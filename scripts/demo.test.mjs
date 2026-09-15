import { describe, it, expect } from 'vitest'
import { lanAddress } from './demo.mjs'

/**
 * Picking the address a phone can actually reach.
 *
 * The failure this guards against is not "no address found" — that is visible
 * and fixable. It is confidently returning one that looks right and is not:
 * a docker bridge, a VPN tunnel, loopback. The person then scans the QR, the
 * app cannot reach the API, and nothing on screen says why.
 */

const ip = (address, extra = {}) => ({ family: 'IPv4', address, internal: false, ...extra })

describe('finding this machine on the LAN', () => {
  it('picks the wifi address on a Mac', () => {
    expect(lanAddress({
      lo0: [ip('127.0.0.1', { internal: true })],
      en0: [ip('192.168.1.42')],
    })).toEqual({ name: 'en0', address: '192.168.1.42' })
  })

  it('picks the wifi address on Linux', () => {
    expect(lanAddress({
      lo: [ip('127.0.0.1', { internal: true })],
      wlp3s0: [ip('10.0.0.7')],
    })).toEqual({ name: 'wlp3s0', address: '10.0.0.7' })
  })

  it('ignores the docker bridge', () => {
    // 172.17.0.1 is private and looks perfectly plausible. A phone cannot
    // route to it, and this is the single most common wrong answer.
    expect(lanAddress({
      docker0: [ip('172.17.0.1')],
      eth0: [ip('192.168.0.15')],
    })).toEqual({ name: 'eth0', address: '192.168.0.15' })
  })

  it('ignores VPN tunnels', () => {
    expect(lanAddress({
      utun4: [ip('10.8.0.2')],
      en0: [ip('192.168.1.5')],
    })).toEqual({ name: 'en0', address: '192.168.1.5' })
  })

  it('ignores a docker-compose network', () => {
    expect(lanAddress({
      'br-1a2b3c': [ip('172.18.0.1')],
      en0: [ip('192.168.4.4')],
    })?.address).toBe('192.168.4.4')
  })

  it('never returns loopback', () => {
    expect(lanAddress({ lo0: [ip('127.0.0.1', { internal: true })] })).toBeNull()
  })

  it('returns nothing rather than a public address', () => {
    // A cloud box or a container on a routable address is not something a
    // phone on your sofa can reach. Saying so beats handing over a URL that
    // times out with no explanation.
    expect(lanAddress({ eth0: [ip('54.12.9.3')] })).toBeNull()
  })

  it('returns nothing rather than a documentation address', () => {
    // 192.0.2.x is RFC 5737 TEST-NET-1, which is what this project's own
    // dev container reports. It is private-looking and entirely unroutable.
    expect(lanAddress({ eth0: [ip('192.0.2.2')] })).toBeNull()
  })

  it('ignores IPv6, which Expo Go does not use for this', () => {
    expect(lanAddress({
      en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }],
    })).toBeNull()
  })

  it('takes a private address on an oddly named interface over nothing', () => {
    expect(lanAddress({ 'Local Area Connection': [ip('192.168.9.9')] })?.address)
      .toBe('192.168.9.9')
  })

  it('prefers a real interface when a virtual one also has a private address', () => {
    const picked = lanAddress({
      vmnet8: [ip('192.168.200.1')],
      'Wi-Fi': [ip('192.168.1.100')],
    })
    expect(picked?.address).toBe('192.168.1.100')
  })
})

import React, { useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { C, mono } from '../theme'
import { probePairing } from '../api'
import type { Pairing } from '../types'

interface Props {
  onPaired: (pairing: Pairing) => void
}

// Scan the QR from Orcha's Settings → Phone (payload: {v, urls, token}),
// probe the candidate addresses, keep whichever answers. Manual entry covers
// a broken camera.
export default function PairingScreen({ onPaired }: Props): React.JSX.Element {
  const [permission, requestPermission] = useCameraPermissions()
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState(false)
  const [host, setHost] = useState('')
  const [token, setToken] = useState('')
  const busy = useRef(false)

  const finish = async (urls: string[], pairToken: string): Promise<void> => {
    if (busy.current) return
    busy.current = true
    setProbing(true)
    setError(null)
    const pairing = await probePairing(urls, pairToken)
    setProbing(false)
    if (pairing) {
      onPaired(pairing)
    } else {
      busy.current = false
      setError(
        'Could not reach Orcha at any address. Is the PC on, Orcha running, and Tailscale connected on both devices?'
      )
    }
  }

  const onScan = (data: string): void => {
    try {
      const parsed = JSON.parse(data) as { v?: number; urls?: string[]; token?: string }
      if (!Array.isArray(parsed.urls) || !parsed.urls.length || !parsed.token) throw new Error()
      void finish(parsed.urls, parsed.token)
    } catch {
      if (!busy.current) setError('That QR is not an Orcha pairing code.')
    }
  }

  const onManual = (): void => {
    const trimmedHost = host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    if (!trimmedHost || !token.trim()) return
    const base = trimmedHost.includes(':') ? trimmedHost : `${trimmedHost}:4680`
    void finish([`http://${base}`], token.trim())
  }

  return (
    <View style={styles.root}>
      <Text style={styles.wordmark}>Orcha</Text>
      <Text style={styles.hint}>
        On your PC: Orcha → Settings → Phone.{'\n'}Scan the pairing code.
      </Text>

      {!manual && (
        <View style={styles.cameraBox}>
          {permission?.granted ? (
            <CameraView
              style={{ flex: 1 }}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => onScan(data)}
            />
          ) : (
            <Pressable style={styles.cameraAsk} onPress={() => void requestPermission()}>
              <Text style={{ color: C.mid, fontSize: 13 }}>Tap to allow the camera</Text>
            </Pressable>
          )}
        </View>
      )}

      {manual && (
        <View style={{ width: '100%', gap: 8 }}>
          <TextInput
            style={styles.input}
            value={host}
            onChangeText={setHost}
            placeholder="PC address (e.g. 100.64.1.2 or orcha-pc)"
            placeholderTextColor={C.faint}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={setToken}
            placeholder="pairing token (shown under the QR)"
            placeholderTextColor={C.faint}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            onPress={onManual}
            disabled={probing}
            style={({ pressed }) => [styles.connect, pressed && { backgroundColor: C.bright }]}
          >
            <Text style={{ color: C.bg, fontWeight: '700', fontSize: 13 }}>Connect</Text>
          </Pressable>
        </View>
      )}

      {probing && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <ActivityIndicator color={C.dim} />
          <Text style={{ color: C.dim, fontSize: 12, fontFamily: mono }}>finding your PC…</Text>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable onPress={() => setManual(!manual)} hitSlop={8} style={{ marginTop: 18 }}>
        <Text style={{ color: C.faint, fontSize: 12 }}>
          {manual ? 'scan the QR instead' : 'enter address manually'}
        </Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28
  },
  wordmark: { color: C.bright, fontSize: 24, fontWeight: '600', letterSpacing: 0.5 },
  hint: {
    color: C.dim,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 10,
    marginBottom: 22
  },
  cameraBox: {
    width: 240,
    height: 240,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: C.edgeBright,
    backgroundColor: C.surface
  },
  cameraAsk: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  input: {
    color: C.text,
    fontSize: 13,
    fontFamily: mono,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.edge,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  connect: {
    backgroundColor: C.text,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 11,
    marginTop: 4
  },
  error: {
    color: C.danger,
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 17,
    marginTop: 14
  }
})

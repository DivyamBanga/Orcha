import React from 'react'
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { C, mono } from './theme'
import type { ActivityState } from './types'

// Session state, same shapes as the desktop sidebar: green ring = working,
// amber ring with a centre dot = waiting on you, hollow zinc = idle/off.
export function StateDot({ state, size = 12 }: { state: ActivityState; size?: number }): React.JSX.Element {
  const color = state === 'working' ? C.work : state === 'waiting' ? C.wait : C.faint
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {state === 'waiting' && (
        <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: color }} />
      )}
    </View>
  )
}

// The 5-hour plan-usage glance: % text in a ring whose colour follows the
// desktop thresholds (neutral < 70, amber >= 70, red >= 90).
export function UsageRing({ pct }: { pct: number }): React.JSX.Element {
  const color = pct >= 90 ? C.danger : pct >= 70 ? C.wait : C.dim
  return (
    <View
      style={{
        minWidth: 40,
        height: 26,
        paddingHorizontal: 8,
        borderRadius: 13,
        borderWidth: 1.5,
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <Text style={{ color, fontSize: 11, fontFamily: mono }}>{pct}%</Text>
    </View>
  )
}

export function Chip({
  label,
  onPress,
  dim
}: {
  label: string
  onPress: () => void
  dim?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        dim && { borderColor: C.edge },
        pressed && { backgroundColor: C.surface2 }
      ]}
    >
      <Text style={{ color: dim ? C.dim : C.mid, fontSize: 12 }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  )
}

export function Card({
  children,
  style
}: {
  children: React.ReactNode
  style?: ViewStyle
}): React.JSX.Element {
  return <View style={[styles.card, style]}>{children}</View>
}

export function ago(seconds: number | null): string {
  if (seconds === null) return ''
  if (seconds < 90) return 'now'
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderColor: C.edge,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12
  },
  chip: {
    borderWidth: 1,
    borderColor: C.edgeBright,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginRight: 6,
    marginTop: 6,
    maxWidth: 260
  }
})

import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView } from 'react-native-webview'
import { C } from '../theme'

interface Props {
  url: string
  title: string
  onBack: () => void
}

// The raw screen, one tap away for when the chat digest isn't enough —
// a read-only xterm viewer served by the PC over the tailnet.
export default function TermPeek({ url, title, onBack }: Props): React.JSX.Element {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={{ color: C.mid, fontSize: 18 }}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.tag}>live · read-only</Text>
      </View>
      <WebView
        source={{ uri: url }}
        style={{ backgroundColor: C.bg }}
        containerStyle={{ backgroundColor: C.bg }}
        setSupportMultipleWindows={false}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.edge
  },
  title: { color: C.bright, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  tag: { color: C.faint, fontSize: 11, marginLeft: 'auto' }
})

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { C, mono } from '../theme'
import { StateDot } from '../components'
import type { Api } from '../api'
import type { ChatBlock, FleetSession } from '../types'

interface Props {
  api: Api
  session: FleetSession
  projectName: string
  onBack: () => void
  onOpenTerm: () => void
}

// One scroll: the transcript as a readable digest (tool calls collapsed
// behind counts), the answer card pinned above the composer when blocked.
export default function Session({
  api,
  session,
  projectName,
  onBack,
  onOpenTerm
}: Props): React.JSX.Element {
  const [blocks, setBlocks] = useState<ChatBlock[] | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // Hide the answer card immediately after answering; the next fleet payload
  // confirms it (optimistic, no confirmation dialogs).
  const [answered, setAnswered] = useState(false)
  const alive = useRef(true)

  const refresh = useCallback((): void => {
    api
      .chat(session.id)
      .then((r) => {
        if (alive.current) setBlocks(r.blocks)
      })
      .catch(() => {})
  }, [api, session.id])

  useEffect(() => {
    alive.current = true
    refresh()
    // Simple liveness: poll faster while the session is working.
    const timer = setInterval(refresh, session.state === 'working' ? 3500 : 8000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh, session.state])

  const ask = !answered ? session.ask : null

  const fail = (err: unknown): void => {
    Alert.alert('Could not send', err instanceof Error ? err.message : String(err))
  }

  const sendOption = (index1: number): void => {
    setSending(true)
    api
      .answerOption(session.id, index1)
      .then(() => setAnswered(true))
      .catch(fail)
      .finally(() => setSending(false))
  }

  const sendText = (): void => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    api
      .answerText(session.id, text)
      .then(() => {
        setDraft('')
        setAnswered(true)
        setTimeout(refresh, 800)
      })
      .catch(fail)
      .finally(() => setSending(false))
  }

  const confirmInterrupt = (): void => {
    Alert.alert('Interrupt', 'Send Esc to interrupt this session?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Interrupt', style: 'destructive', onPress: () => api.interrupt(session.id).catch(fail) }
    ])
  }

  const data = (blocks ?? []).slice().reverse()

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={{ color: C.mid, fontSize: 18 }}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {projectName} · {session.name}
        </Text>
        <StateDot state={session.state} />
        <View style={{ flex: 1 }} />
        <Pressable onPress={onOpenTerm} hitSlop={10} style={{ marginRight: 14 }}>
          <Text style={styles.headerAction}>▣</Text>
        </Pressable>
        <Pressable onPress={confirmInterrupt} hitSlop={10}>
          <Text style={styles.headerAction}>◼</Text>
        </Pressable>
      </View>

      <FlatList
        inverted
        data={data}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => <Block block={item} />}
        contentContainerStyle={{ padding: 14, paddingBottom: 20 }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {blocks === null ? 'loading…' : 'no local transcript for this session'}
          </Text>
        }
      />

      {ask && (
        <View style={styles.askCard}>
          <Text style={styles.askLabel}>WAITING</Text>
          <Text style={styles.askQuestion}>{ask.question}</Text>
          {ask.options.map((option, i) => (
            <Pressable
              key={i}
              disabled={sending}
              onPress={() => sendOption(i + 1)}
              style={({ pressed }) => [styles.option, pressed && { backgroundColor: C.surface2 }]}
            >
              <Text style={styles.optionLabel}>{option.label}</Text>
              {option.description ? (
                <Text style={styles.optionDesc} numberOfLines={2}>
                  {option.description}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={ask ? 'or type a reply…' : 'message this session…'}
          placeholderTextColor={C.faint}
          multiline
          editable={!sending}
        />
        <Pressable
          onPress={sendText}
          disabled={sending || !draft.trim()}
          style={({ pressed }) => [
            styles.send,
            (sending || !draft.trim()) && { opacity: 0.4 },
            pressed && { backgroundColor: C.bright }
          ]}
        >
          <Text style={{ color: C.bg, fontSize: 15, fontWeight: '700' }}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

function Block({ block }: { block: ChatBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (block.kind === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={{ color: C.text, fontSize: 13, lineHeight: 19 }}>{block.text}</Text>
        </View>
      </View>
    )
  }
  if (block.kind === 'tools') {
    const tools = block.tools ?? []
    return (
      <Pressable onPress={() => setOpen(!open)} style={styles.toolsRow}>
        <Text style={{ color: C.faint, fontSize: 11, fontFamily: mono }}>
          {open ? '▾' : '▸'} {tools.length} tool {tools.length === 1 ? 'call' : 'calls'}
        </Text>
        {open &&
          tools.map((tool, i) => (
            <Text key={i} style={styles.toolLine} numberOfLines={1}>
              {tool.name}
              {tool.arg ? `  ${tool.arg}` : ''}
            </Text>
          ))}
      </Pressable>
    )
  }
  return <Text style={styles.assistant}>{block.text}</Text>
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
  headerAction: { color: C.dim, fontSize: 15 },
  empty: { color: C.faint, fontSize: 12, textAlign: 'center', transform: [{ scaleY: -1 }] },
  userRow: { alignItems: 'flex-end', marginBottom: 10 },
  userBubble: {
    backgroundColor: C.surface2,
    borderRadius: 12,
    borderBottomRightRadius: 3,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: '85%'
  },
  assistant: { color: C.text, fontSize: 13, lineHeight: 19, marginBottom: 10 },
  toolsRow: { marginBottom: 10, paddingLeft: 2 },
  toolLine: { color: C.faint, fontSize: 11, fontFamily: mono, marginTop: 3, paddingLeft: 14 },
  askCard: {
    borderTopWidth: 1,
    borderTopColor: C.edge,
    borderLeftWidth: 2,
    borderLeftColor: C.wait,
    backgroundColor: C.surface,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  askLabel: { color: C.wait, fontSize: 10, fontFamily: mono, letterSpacing: 1 },
  askQuestion: { color: C.text, fontSize: 13, lineHeight: 19, marginTop: 4, marginBottom: 6 },
  option: {
    borderWidth: 1,
    borderColor: C.edgeBright,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 6
  },
  optionLabel: { color: C.bright, fontSize: 13, fontWeight: '600' },
  optionDesc: { color: C.dim, fontSize: 11, marginTop: 2, lineHeight: 15 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: C.edge
  },
  input: {
    flex: 1,
    color: C.text,
    fontSize: 13,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.edge,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxHeight: 120
  },
  send: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.text,
    alignItems: 'center',
    justifyContent: 'center'
  }
})

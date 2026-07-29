import React, { useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { C } from '../theme'
import { Chip } from '../components'
import type { Api } from '../api'
import type { FleetProject, NextStep } from '../types'

interface Props {
  api: Api
  project: FleetProject
  prefill: NextStep | null
  onClose: () => void
  onDispatched: () => void
}

// Bottom sheet, deliberately bare: the full prompt, editable, and Start.
// A chip tap lands here with the prompt visible — chips preview a dispatch,
// they never blind-send. No model/worktree pickers; defaults live on the PC.
export default function DispatchSheet({
  api,
  project,
  prefill,
  onClose,
  onDispatched
}: Props): React.JSX.Element {
  const [draft, setDraft] = useState(prefill?.prompt ?? '')
  const [sending, setSending] = useState(false)

  const start = (): void => {
    const prompt = draft.trim()
    if (!prompt || sending) return
    setSending(true)
    api
      .dispatch(project.id, prompt)
      .then(() => {
        onDispatched()
        onClose()
      })
      .catch((err) =>
        Alert.alert('Could not start', err instanceof Error ? err.message : String(err))
      )
      .finally(() => setSending(false))
  }

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.sheet}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
            <Text style={styles.title}>New task · {project.name}</Text>
            <View style={{ flex: 1 }} />
            <Pressable onPress={onClose} hitSlop={10}>
              <Text style={{ color: C.dim, fontSize: 15 }}>✕</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="what should this project's session do?"
            placeholderTextColor={C.faint}
            multiline
            autoFocus
          />

          {project.nextSteps.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 }}>
              {project.nextSteps.map((step) => (
                <Chip
                  key={step.label}
                  label={step.label}
                  dim={step.prompt === draft}
                  onPress={() => setDraft(step.prompt)}
                />
              ))}
            </View>
          )}

          <Pressable
            onPress={start}
            disabled={sending || !draft.trim()}
            style={({ pressed }) => [
              styles.start,
              (sending || !draft.trim()) && { opacity: 0.4 },
              pressed && { backgroundColor: C.bright }
            ]}
          >
            <Text style={{ color: C.bg, fontSize: 14, fontWeight: '700' }}>
              {sending ? 'Starting…' : 'Start ▶'}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: C.edge,
    padding: 16,
    paddingBottom: 26
  },
  title: { color: C.bright, fontSize: 14, fontWeight: '600' },
  input: {
    color: C.text,
    fontSize: 13,
    lineHeight: 19,
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.edge,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 84,
    maxHeight: 200,
    textAlignVertical: 'top'
  },
  start: {
    marginTop: 14,
    backgroundColor: C.text,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 11
  }
})

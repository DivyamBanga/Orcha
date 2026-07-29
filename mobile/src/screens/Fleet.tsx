import React from 'react'
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { C, mono } from '../theme'
import { Card, Chip, StateDot, UsageRing, ago } from '../components'
import type { FleetPayload, FleetProject, FleetSession, NextStep } from '../types'

interface Props {
  fleet: FleetPayload | null
  error: string | null
  refreshing: boolean
  onRefresh: () => void
  onOpenSession: (sessionId: string) => void
  onDispatch: (project: FleetProject, prefill: NextStep | null) => void
  onRegenSteps: (projectId: string) => void
  regenInflight: string | null
  onUnpair: () => void
}

// Home = the attention inbox: whatever needs you first (with the actual
// question), then every project at a glance with next-step chips.
export default function Fleet(props: Props): React.JSX.Element {
  const { fleet } = props
  const needsYou =
    fleet?.projects.flatMap((p) =>
      p.sessions.filter((s) => s.ask).map((s) => ({ project: p, session: s }))
    ) ?? []

  const confirmUnpair = (): void => {
    Alert.alert('Unpair', 'Disconnect this phone from Orcha?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unpair', style: 'destructive', onPress: props.onUnpair }
    ])
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.wordmark}>Orcha</Text>
        <View style={{ flex: 1 }} />
        {fleet?.usage && <UsageRing pct={fleet.usage.pct} />}
        <Pressable onPress={confirmUnpair} hitSlop={10} style={{ marginLeft: 12 }}>
          <Text style={{ color: C.faint, fontSize: 16 }}>⚙</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl
            refreshing={props.refreshing}
            onRefresh={props.onRefresh}
            tintColor={C.dim}
          />
        }
      >
        {props.error && (
          <Card style={{ borderColor: '#7f1d1d', marginBottom: 12 }}>
            <Text style={{ color: C.danger, fontSize: 12, fontFamily: mono }}>{props.error}</Text>
          </Card>
        )}

        {needsYou.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>NEEDS YOU</Text>
            {needsYou.map(({ project, session }) => (
              <Pressable key={session.id} onPress={() => props.onOpenSession(session.id)}>
                <Card style={{ borderLeftColor: C.wait, borderLeftWidth: 2, marginBottom: 8 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <StateDot state="waiting" />
                    <Text style={styles.needsTitle} numberOfLines={1}>
                      {project.name} · {session.name}
                    </Text>
                    <Text style={styles.age}>
                      {session.askAt ? ago((Date.now() - session.askAt) / 1000) : ''}
                    </Text>
                  </View>
                  <Text style={styles.question} numberOfLines={2}>
                    “{session.ask?.question}”
                  </Text>
                </Card>
              </Pressable>
            ))}
          </>
        )}

        {fleet?.projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onOpenSession={props.onOpenSession}
            onDispatch={props.onDispatch}
            onRegenSteps={props.onRegenSteps}
            regenInflight={props.regenInflight === project.id}
          />
        ))}

        {fleet && fleet.projects.length === 0 && (
          <Text style={{ color: C.faint, fontSize: 13, textAlign: 'center', marginTop: 60 }}>
            No projects yet — add one in Orcha on your PC.
          </Text>
        )}
      </ScrollView>
    </View>
  )
}

function sessionSubtitle(s: FleetSession): string {
  if (s.state === 'working') return s.lastLine ?? 'working'
  if (s.state === 'waiting' && s.ask) return 'waiting on your answer'
  if (s.state === 'waiting') {
    const when = ago(s.lastActivityAgoS)
    return when === 'now' ? 'idle' : `idle · ${when}`
  }
  return s.terminalOpen ? 'starting' : 'not started'
}

function ProjectCard({
  project,
  onOpenSession,
  onDispatch,
  onRegenSteps,
  regenInflight
}: {
  project: FleetProject
  onOpenSession: (sessionId: string) => void
  onDispatch: (project: FleetProject, prefill: NextStep | null) => void
  onRegenSteps: (projectId: string) => void
  regenInflight: boolean
}): React.JSX.Element {
  return (
    <Card style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
        <Text style={styles.projectName} numberOfLines={1}>
          {project.name}
        </Text>
        {project.ssh && <Text style={styles.sshTag}>ssh</Text>}
        <View style={{ flex: 1 }} />
        <Pressable onPress={() => onDispatch(project, null)} hitSlop={8}>
          <Text style={{ color: C.dim, fontSize: 18, lineHeight: 20 }}>＋</Text>
        </Pressable>
      </View>

      {project.sessions.map((session) => (
        <Pressable
          key={session.id}
          onPress={() => onOpenSession(session.id)}
          style={({ pressed }) => [styles.sessionRow, pressed && { backgroundColor: C.surface2 }]}
        >
          <StateDot state={session.state} />
          <Text style={styles.sessionName} numberOfLines={1}>
            {session.name}
          </Text>
          <Text style={styles.sessionSub} numberOfLines={1}>
            {sessionSubtitle(session)}
          </Text>
        </Pressable>
      ))}
      {project.sessions.length === 0 && (
        <Text style={{ color: C.faint, fontSize: 12, paddingVertical: 4 }}>no open sessions</Text>
      )}

      {(project.nextSteps.length > 0 || regenInflight) && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
          <Text style={{ color: C.faint, fontSize: 11, marginTop: 6, marginRight: 2 }}>▸ next:</Text>
          {project.nextSteps.slice(0, 2).map((step) => (
            <Chip key={step.label} label={step.label} onPress={() => onDispatch(project, step)} />
          ))}
          <Chip
            dim
            label={regenInflight ? '…' : '↻'}
            onPress={() => !regenInflight && onRegenSteps(project.id)}
          />
        </View>
      )}
    </Card>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.edge
  },
  wordmark: { color: C.bright, fontSize: 17, fontWeight: '600', letterSpacing: 0.3 },
  sectionLabel: {
    color: C.faint,
    fontSize: 11,
    fontFamily: mono,
    letterSpacing: 1,
    marginBottom: 6,
    marginTop: 2
  },
  needsTitle: { color: C.text, fontSize: 13, fontWeight: '600', marginLeft: 8, flexShrink: 1 },
  age: { color: C.faint, fontSize: 11, fontFamily: mono, marginLeft: 8 },
  question: { color: C.mid, fontSize: 13, marginTop: 6, lineHeight: 18 },
  projectName: { color: C.bright, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  sshTag: {
    color: C.dim,
    fontSize: 10,
    fontFamily: mono,
    borderWidth: 1,
    borderColor: C.edge,
    borderRadius: 4,
    paddingHorizontal: 4,
    marginLeft: 6
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 6
  },
  sessionName: { color: C.text, fontSize: 13, marginLeft: 8 },
  sessionSub: { color: C.faint, fontSize: 11, marginLeft: 8, flex: 1, textAlign: 'right' }
})

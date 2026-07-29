import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import Constants from 'expo-constants'

// Show pushes while the app is open too — the fleet updates alongside.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false
  })
})

// Channels match the desktop's two phone-worthy ping kinds: blocked buzzes,
// finished arrives quietly. The 'blocked' category adds inline reply so a
// question can be answered from the notification shade without opening the app.
export async function setupPush(): Promise<{ token: string | null; error: string | null }> {
  if (!Device.isDevice) return { token: null, error: 'push needs a physical device' }
  const perm = await Notifications.requestPermissionsAsync()
  if (!perm.granted) return { token: null, error: 'notifications not allowed' }

  await Notifications.setNotificationChannelAsync('blocked', {
    name: 'Needs your answer',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 250, 150, 250],
    lightColor: '#f59e0b'
  })
  await Notifications.setNotificationChannelAsync('finished', {
    name: 'Finished working',
    importance: Notifications.AndroidImportance.DEFAULT
  })
  await Notifications.setNotificationCategoryAsync('blocked', [
    {
      identifier: 'reply',
      buttonTitle: 'Reply',
      textInput: { submitButtonTitle: 'Send', placeholder: 'Type your answer…' }
    }
  ])

  try {
    const projectId: string | undefined = (
      Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
    )?.eas?.projectId
    const token = (
      await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)
    ).data
    return { token, error: null }
  } catch (err) {
    // Most likely: no EAS projectId yet (run `eas init`) or missing
    // google-services.json. The app still works — just without push.
    return { token: null, error: err instanceof Error ? err.message : String(err) }
  }
}

import { useCallback, useState } from 'react'
import { View, Text, StyleSheet, Pressable, Image, ActivityIndicator, ScrollView } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import { uploadJobPhoto, failureMessage, UPLOAD_QUALITY } from '@/lib/photo-upload'

/**
 * Photos of the yard, added after the job is posted.
 *
 * Deliberately not part of the five-step post flow. A photo has to be presigned
 * against a job that exists, and the job does not exist until the flow's last
 * step completes — so collecting them earlier was never possible, only
 * apparently possible. Posting first is the better order anyway: the job goes
 * live in seconds and the customer enriches it while pros are already looking.
 *
 * Worth the prompt because an unclear job is one a pro prices defensively or
 * skips: "how big is the hedge" is answered faster by a photo than by any
 * description field.
 */
export function ListingPhotos({ jobId, existing, onUploaded }: {
  jobId: string
  existing: Array<{ id: string; url: string }>
  onUploaded: () => void
}) {
  const c = useColors()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const add = useCallback(async (source: 'CAMERA' | 'LIBRARY') => {
    setError(null)
    const permission = source === 'CAMERA'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!permission.granted) {
      setError(failureMessage({ reason: 'PERMISSION' }))
      return
    }

    const picked = source === 'CAMERA'
      ? await ImagePicker.launchCameraAsync({ quality: UPLOAD_QUALITY, exif: false })
      : await ImagePicker.launchImageLibraryAsync({
          quality: UPLOAD_QUALITY,
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
        })
    if (picked.canceled || !picked.assets?.[0]) return

    setBusy(true)
    try {
      const asset = picked.assets[0]
      const result = await uploadJobPhoto({
        jobId,
        kind: 'LISTING',
        asset: { uri: asset.uri, fileSize: asset.fileSize },
      })
      if (result.ok) onUploaded()
      else setError(failureMessage(result.failure))
    } finally {
      setBusy(false)
    }
  }, [jobId, onUploaded])

  return (
    <View style={[styles.panel, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>PHOTOS OF THE YARD</Text>
      <Text style={[textStyles.body, { color: c.textSecondary }]}>
        {existing.length > 0
          ? 'Pros see these before they claim.'
          : 'Optional, but a job with a photo gets claimed faster — a pro can see what they are taking on instead of guessing.'}
      </Text>

      {existing.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
          {existing.map((photo) => (
            <Image key={photo.id} source={{ uri: photo.url }} style={styles.thumb} />
          ))}
        </ScrollView>
      ) : null}

      {error ? <Text style={[textStyles.caption, { color: c.danger }]}>{error}</Text> : null}

      <View style={styles.actions}>
        <Pressable
          onPress={() => void add('CAMERA')}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Take a photo of the yard"
          style={[styles.button, { borderColor: c.border, backgroundColor: c.surfaceSunken }]}
        >
          {busy
            ? <ActivityIndicator color={c.brand} size="small" />
            : <Text style={{ color: c.textPrimary, fontWeight: '700', fontSize: 14 }}>Take photo</Text>}
        </Pressable>
        <Pressable
          onPress={() => void add('LIBRARY')}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Choose a photo of the yard"
          style={[styles.button, { borderColor: c.border, backgroundColor: c.surfaceSunken }]}
        >
          <Text style={{ color: c.textPrimary, fontWeight: '700', fontSize: 14 }}>Choose</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[2] },
  thumb: { width: 96, height: 72, borderRadius: radius.md },
  actions: { flexDirection: 'row', gap: space[2], marginTop: space[1] },
  button: {
    flex: 1, minHeight: minTouchTarget, borderWidth: 1, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
})

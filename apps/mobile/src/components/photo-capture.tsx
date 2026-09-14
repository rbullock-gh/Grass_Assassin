import { useCallback, useState } from 'react'
import { View, Text, StyleSheet, Pressable, Image, ActivityIndicator, ScrollView } from 'react-native'
import * as ImagePicker from 'expo-image-picker'
import * as Location from 'expo-location'
import type { PhotoKind } from '@grassassassin/client'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import {
  uploadJobPhoto, failureMessage, gatePrompt, gateSatisfied, UPLOAD_QUALITY,
} from '@/lib/photo-upload'

/**
 * Taking the before and after photos.
 *
 * This is not an optional nicety. The server refuses to let a worker start
 * without a confirmed BEFORE photo and refuses to let them finish without an
 * AFTER — so until this existed, a worker could claim a job and then be stopped
 * dead by "Upload before photos to start work" with no way to comply. The loop
 * was broken on a real device while every test passed.
 *
 * Camera first, library second. The photo is evidence of a specific yard at a
 * specific moment; a library pick is the one that can be faked, so it is the
 * secondary option rather than the default.
 */
export function PhotoCapture({ jobId, kind, existing, onUploaded }: {
  jobId: string
  kind: Extract<PhotoKind, 'BEFORE' | 'AFTER'>
  existing: Array<{ id: string; url: string }>
  onUploaded: () => void
}) {
  const c = useColors()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const capture = useCallback(async (source: 'CAMERA' | 'LIBRARY') => {
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
      // Location travels with the photo where we have it, because "the photo
      // was taken at the property" is the single most useful fact in a dispute.
      // Its absence never blocks the upload.
      const permissionState = await Location.getForegroundPermissionsAsync()
      const position = permissionState.status === 'granted'
        ? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null)
        : null

      const asset = picked.assets[0]
      const result = await uploadJobPhoto({
        jobId,
        kind,
        asset: { uri: asset.uri, fileSize: asset.fileSize },
        ...(position
          ? { capturedLocation: { lat: position.coords.latitude, lng: position.coords.longitude } }
          : {}),
      })

      if (result.ok) onUploaded()
      else setError(failureMessage(result.failure))
    } finally {
      setBusy(false)
    }
  }, [jobId, kind, onUploaded])

  const satisfied = gateSatisfied(kind, existing.length)

  return (
    <View style={[styles.panel, { backgroundColor: c.surface, borderColor: satisfied ? c.brand : c.border }]}>
      <Text style={[textStyles.captionStrong, { color: satisfied ? c.brand : c.textSecondary }]}>
        {kind === 'BEFORE' ? 'BEFORE PHOTOS' : 'AFTER PHOTOS'}
      </Text>
      <Text style={[textStyles.body, { color: c.textSecondary }]}>
        {gatePrompt(kind, existing.length)}
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
          onPress={() => void capture('CAMERA')}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Take a ${kind.toLowerCase()} photo`}
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: pressed ? c.brandHover : c.brand, opacity: busy ? 0.6 : 1 },
          ]}
        >
          {busy
            ? <ActivityIndicator color={c.onBrand} />
            : <Text style={{ color: c.onBrand, fontWeight: '800', fontSize: 14 }}>TAKE PHOTO</Text>}
        </Pressable>

        <Pressable
          onPress={() => void capture('LIBRARY')}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Choose an existing photo"
          style={[styles.secondary, { borderColor: c.border }]}
        >
          <Text style={{ color: c.textSecondary, fontWeight: '600', fontSize: 14 }}>Choose</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[2] },
  thumb: { width: 96, height: 72, borderRadius: radius.md },
  actions: { flexDirection: 'row', gap: space[2], marginTop: space[1] },
  primary: {
    flex: 1, minHeight: minTouchTarget, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  secondary: {
    minWidth: 92, minHeight: minTouchTarget, borderWidth: 1, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center',
  },
})

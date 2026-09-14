import { View, Text, TextInput, StyleSheet } from 'react-native'
import { useColors, space, radius, minTouchTarget } from '@/lib/theme'

/**
 * The text field used across every form.
 *
 * Lives here rather than inside a route file: a screen importing a component
 * out of another screen drags that whole route into its bundle, and the two
 * then cannot be changed independently.
 *
 * The error is part of the field rather than a banner at the top. A form that
 * greys out its submit button and says nothing about why is the single most
 * common way to lose someone who was ready to give you their money.
 */
export function Input({ label, error, hint, ...props }: {
  label: string
  value: string
  onChangeText: (text: string) => void
  placeholder?: string
  error?: string | undefined
  hint?: string | undefined
  secureTextEntry?: boolean
  keyboardType?: 'default' | 'email-address' | 'number-pad'
  autoCapitalize?: 'none' | 'words'
  autoComplete?: 'email' | 'current-password' | 'new-password' | 'name'
}) {
  const c = useColors()
  return (
    <View style={{ gap: space[1] }}>
      <Text style={[styles.label, { color: c.textSecondary }]}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={c.textTertiary}
        accessibilityLabel={label}
        // Announced to a screen reader, which otherwise gets a red border and
        // no idea anything is wrong.
        accessibilityHint={error ?? hint}
        style={[
          styles.input,
          {
            backgroundColor: c.surface,
            borderColor: error ? c.danger : c.border,
            color: c.textPrimary,
          },
        ]}
      />
      {error ? (
        <Text style={[styles.message, { color: c.danger }]}>{error}</Text>
      ) : hint ? (
        <Text style={[styles.message, { color: c.textTertiary }]}>{hint}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  label: { fontSize: 12.5, fontWeight: '700', letterSpacing: 0.3 },
  input: {
    borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3],
    minHeight: minTouchTarget, fontSize: 16,
  },
  message: { fontSize: 12.5, fontWeight: '600' },
})

import { View, Text, StyleSheet, ScrollView, Pressable, Modal } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Category } from '@grassassassin/client'
import { useColors, space, radius, textStyles, minTouchTarget } from '@/lib/theme'
import {
  DISTANCE_PRESETS_MILES, MIN_PAYOUT_PRESETS_CENTS, DIFFICULTY_LABELS,
  toggleFilterValue, toggleCategory, setDeadlineFilter, deadlineFilterOf,
  countActiveFilters, displayPayout, EMPTY_FILTERS, type Filters,
} from '@/lib/jobs'

/**
 * The filter sheet.
 *
 * Every filter is a row of taps rather than a slider or a picker: this is used
 * one-handed, outdoors, often in a truck, and a precision gesture in that
 * context is a filter nobody uses. Tapping the value that is already set clears
 * it, so a mis-tap costs one tap rather than a Clear All that throws away the
 * other four.
 *
 * Applied live, with no Apply button. The job count behind the sheet updates as
 * the worker taps, which answers "did that help?" without making them commit
 * first and find out afterwards.
 */
export function FilterSheet({ visible, filters, categories, resultCount, onChange, onClose }: {
  visible: boolean
  filters: Filters
  categories: Category[]
  resultCount: number
  onChange: (next: Filters) => void
  onClose: () => void
}) {
  const c = useColors()
  const insets = useSafeAreaInsets()
  const active = countActiveFilters(filters)
  const deadline = deadlineFilterOf(filters)

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close filters" />
      <View
        style={[
          styles.sheet,
          { backgroundColor: c.surface, borderColor: c.border, paddingBottom: insets.bottom + space[4] },
        ]}
      >
        <View style={styles.grabber}>
          <View style={[styles.grabberBar, { backgroundColor: c.borderStrong }]} />
        </View>

        <View style={styles.header}>
          <Text style={[textStyles.heading, { color: c.textPrimary }]}>Filters</Text>
          <Pressable
            onPress={() => onChange(EMPTY_FILTERS)}
            disabled={active === 0}
            accessibilityRole="button"
            accessibilityLabel="Clear all filters"
            style={styles.clear}
          >
            <Text style={{ color: active > 0 ? c.brand : c.textTertiary, fontWeight: '700' }}>
              {active > 0 ? `Clear ${active}` : 'None set'}
            </Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ gap: space[5], paddingBottom: space[4] }}>
          <Group label="MAXIMUM DISTANCE">
            {DISTANCE_PRESETS_MILES.map((miles) => (
              <Chip
                key={miles}
                label={`${miles} mi`}
                selected={filters.maxDistanceMiles === miles}
                onPress={() => onChange(toggleFilterValue(filters, 'maxDistanceMiles', miles))}
              />
            ))}
          </Group>

          <Group label="MINIMUM PAYOUT">
            {MIN_PAYOUT_PRESETS_CENTS.map((cents) => (
              <Chip
                key={cents}
                label={`${displayPayout(cents)}+`}
                selected={filters.minPayoutCents === cents}
                onPress={() => onChange(toggleFilterValue(filters, 'minPayoutCents', cents))}
              />
            ))}
          </Group>

          {categories.length > 0 ? (
            <Group label="WORK TYPE">
              {categories.map((category) => (
                <Chip
                  key={category.id}
                  label={category.name}
                  selected={filters.categoryIds?.includes(category.id) ?? false}
                  onPress={() => onChange(toggleCategory(filters, category.id))}
                />
              ))}
            </Group>
          ) : null}

          <Group label="DIFFICULTY">
            {(Object.keys(DIFFICULTY_LABELS) as Array<keyof typeof DIFFICULTY_LABELS>).map((level) => (
              <Chip
                key={level}
                label={DIFFICULTY_LABELS[level]}
                selected={filters.difficulty === level}
                onPress={() => onChange(toggleFilterValue(filters, 'difficulty', level))}
              />
            ))}
          </Group>

          <Group label="EQUIPMENT">
            <Chip
              label="Customer provides gear"
              selected={filters.equipmentProvided === true}
              onPress={() => onChange(toggleFilterValue(filters, 'equipmentProvided', true))}
            />
            <Chip
              label="I bring my own"
              selected={filters.equipmentProvided === false}
              onPress={() => onChange(toggleFilterValue(filters, 'equipmentProvided', false))}
            />
          </Group>

          <Group label="DEADLINE">
            <Chip
              label="Due today"
              selected={deadline === 'TODAY'}
              onPress={() => onChange(setDeadlineFilter(filters, deadline === 'TODAY' ? null : 'TODAY'))}
            />
            <Chip
              label="Due this week"
              selected={deadline === 'THIS_WEEK'}
              onPress={() => onChange(setDeadlineFilter(filters, deadline === 'THIS_WEEK' ? null : 'THIS_WEEK'))}
            />
          </Group>
        </ScrollView>

        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.done,
            { backgroundColor: pressed ? c.brandHover : c.brand },
          ]}
        >
          <Text style={{ color: c.onBrand, fontWeight: '800', fontSize: 15 }}>
            {resultCount === 0
              ? 'NO JOBS MATCH'
              : `SHOW ${resultCount} ${resultCount === 1 ? 'JOB' : 'JOBS'}`}
          </Text>
        </Pressable>
      </View>
    </Modal>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  const c = useColors()
  return (
    <View style={{ gap: space[2] }}>
      <Text style={[textStyles.captionStrong, { color: c.textSecondary }]}>{label}</Text>
      <View style={styles.chipWrap}>{children}</View>
    </View>
  )
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const c = useColors()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[
        styles.chip,
        {
          backgroundColor: selected ? c.brandSubtle : c.surfaceSunken,
          borderColor: selected ? c.brand : c.border,
          borderWidth: selected ? 2 : 1,
        },
      ]}
    >
      <Text style={{ color: selected ? c.brand : c.textPrimary, fontWeight: '600', fontSize: 13.5 }}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    maxHeight: '86%',
    borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
    borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1,
    paddingHorizontal: space[5],
  },
  grabber: { alignItems: 'center', paddingVertical: space[2] },
  grabberBar: { width: 40, height: 4, borderRadius: radius.full },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space[4] },
  clear: { minHeight: minTouchTarget, justifyContent: 'center', paddingHorizontal: space[1] },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
  chip: {
    borderRadius: radius.full, paddingHorizontal: space[3],
    minHeight: minTouchTarget, alignItems: 'center', justifyContent: 'center',
  },
  done: {
    minHeight: minTouchTarget + 6, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', marginTop: space[2],
  },
})

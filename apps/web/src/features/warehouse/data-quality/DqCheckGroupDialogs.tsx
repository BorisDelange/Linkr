import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { FormField } from '@/components/ui/form-field'
import { Button } from '@/components/ui/button'
import { LocalizedFields, trimLocalized } from '@/components/ui/localized-fields'
import { FieldError } from '@/components/ui/field-error'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { groupLabel, groupTree, subtreeKeys } from '@/lib/dq-groups'
import { hasLocalizedContent } from '@/lib/localized'
import type { DqCheckGroup, LocalizedString } from '@/types'

const TOP = '__top__'
const OTHER = '__other__'
const NEW = '__new__'

/** Every category, depth-first, for a picker: indented under its parent. */
function groupOptions(groups: DqCheckGroup[], lang: string) {
  const out: { key: string; label: string; depth: number }[] = []
  const walk = (nodes: ReturnType<typeof groupTree>['roots'], depth: number) => {
    for (const n of nodes) {
      out.push({ key: n.key, label: groupLabel(n, lang), depth })
      walk(n.children, depth + 1)
    }
  }
  walk(groupTree(groups, []).roots, 0)
  return out
}

function GroupOption({ label, depth }: { label: string; depth: number }) {
  return <span style={{ paddingLeft: depth * 12 }}>{label}</span>
}

/** A name in each language, and whether a sibling already carries one of them. */
function useGroupName(groups: DqCheckGroup[], initial: LocalizedString = {}) {
  const { t } = useTranslation()
  const [name, setName] = useState<LocalizedString>(initial)
  const clashesWith = (parentKey: string | null, except?: string) => {
    const taken = new Set(groups
      .filter((g) => (g.parentKey ?? null) === parentKey && g.key !== except)
      .flatMap((g) => Object.values(g.name).map((v) => v.trim().toLowerCase())))
    return Object.values(name).some((v) => v.trim() && taken.has(v.trim().toLowerCase()))
  }
  return {
    name,
    setName,
    filled: hasLocalizedContent(trimLocalized(name)),
    clashesWith,
    clashMessage: t('data_quality.group_exists'),
  }
}

/**
 * Creates a category, or edits one (`editing`): its name in each language and
 * the category it sits in.
 */
export function GroupDialog({ open, onOpenChange, groups, editing, defaultParent = null, onSave }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every category of the rule set, the implicit ones included. */
  groups: DqCheckGroup[]
  editing?: DqCheckGroup | null
  defaultParent?: string | null
  onSave: (name: LocalizedString, parentKey: string | null) => Promise<boolean> | void
}) {
  return open ? (
    <GroupDialogBody open={open} onOpenChange={onOpenChange} groups={groups} editing={editing} defaultParent={defaultParent} onSave={onSave} />
  ) : null
}

function GroupDialogBody({ open, onOpenChange, groups, editing, defaultParent, onSave }: Parameters<typeof GroupDialog>[0]) {
  const { t, i18n } = useTranslation()
  const group = useGroupName(groups, editing?.name)
  const [parent, setParent] = useState<string>(editing ? editing.parentKey ?? TOP : defaultParent ?? TOP)
  const [busy, setBusy] = useState(false)
  const parentKey = parent === TOP ? null : parent
  // A category cannot go inside itself or one of its own.
  const excluded = editing ? subtreeKeys(groups, editing.key) : new Set<string>()
  const options = groupOptions(groups, i18n.language).filter((o) => !excluded.has(o.key))
  const clash = group.clashesWith(parentKey, editing?.key)

  const save = async () => {
    setBusy(true)
    const ok = await onSave(trimLocalized(group.name), parentKey)
    setBusy(false)
    if (ok !== false) onOpenChange(false)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={t(editing ? 'data_quality.edit_group_title' : 'data_quality.new_group_title')}
      description={t('data_quality.new_group_description')}
      onConfirm={() => void save()}
      confirmLabel={t(editing ? 'common.save' : 'common.create')}
      confirmDisabled={!group.filled || clash}
      busy={busy}
    >
      <FormField label={t('data_quality.group_name')} required>
        {({ id }) => <LocalizedFields id={id} value={group.name} onChange={group.setName} autoFocus />}
      </FormField>
      <FieldError message={clash ? group.clashMessage : null} />
      <FormField label={t('data_quality.group_parent')}>
        {({ id }) => (
          <Select value={parent} onValueChange={setParent}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TOP}>{t('data_quality.group_top')}</SelectItem>
              {options.length > 0 && <SelectSeparator />}
              {options.map((o) => (
                <SelectItem key={o.key} value={o.key}><GroupOption label={o.label} depth={o.depth} /></SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>
    </DialogShell>
  )
}

export function MoveChecksDialog({ open, onOpenChange, count, groups, current, error, onMove }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  groups: DqCheckGroup[]
  /** The category the checks are in, when they share one; left out. */
  current?: string | null
  /** Why the last move failed; the dialog stays open on it. */
  error?: string | null
  /** `null` moves them to "Other checks"; a name creates that category at the top first. */
  onMove: (target: { key: string | null } | { name: LocalizedString }) => Promise<boolean>
}) {
  const { t, i18n } = useTranslation()
  const [target, setTarget] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const group = useGroupName(groups)
  const close = (next: boolean) => {
    if (!next) {
      setTarget('')
      group.setName({})
    }
    onOpenChange(next)
  }
  const clash = target === NEW && group.clashesWith(null)
  const canMove = target === NEW ? group.filled && !clash : !!target
  const move = async () => {
    setBusy(true)
    const ok = await onMove(
      target === NEW ? { name: trimLocalized(group.name) } : { key: target === OTHER ? null : target },
    )
    setBusy(false)
    if (ok) close(false)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={close}
      title={t('data_quality.move_checks_title', { count })}
      onConfirm={() => void move()}
      confirmLabel={t('data_quality.move')}
      confirmDisabled={!canMove}
      busy={busy}
    >
      <FormField label={t('data_quality.move_to_group')}>
        {({ id }) => (
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id={id}>
              <SelectValue placeholder={t('data_quality.select_group')} />
            </SelectTrigger>
            <SelectContent>
              {groupOptions(groups, i18n.language).filter((o) => o.key !== current).map((o) => (
                <SelectItem key={o.key} value={o.key}><GroupOption label={o.label} depth={o.depth} /></SelectItem>
              ))}
              {current !== null && <SelectItem value={OTHER}>{t('data_quality.group_other')}</SelectItem>}
              <SelectSeparator />
              <SelectItem value={NEW}>{t('data_quality.new_group_option')}</SelectItem>
            </SelectContent>
          </Select>
        )}
      </FormField>
      {target === NEW && (
        <>
          <FormField label={t('data_quality.group_name')} required>
            {({ id }) => <LocalizedFields id={id} value={group.name} onChange={group.setName} autoFocus />}
          </FormField>
          <FieldError message={clash ? group.clashMessage : null} />
        </>
      )}
      {error && <p className="break-words text-xs text-destructive">{t('data_quality.checks_change_failed', { message: error })}</p>}
    </DialogShell>
  )
}

/**
 * Deleting a category asks what becomes of its checks: gone with it (and with
 * its sub-categories), or kept, moving up with its sub-categories to the
 * category above. An empty category only needs the confirmation.
 */
export function DeleteGroupDialog({ group, count, hasChildren = false, canKeepChecks = true, error, onOpenChange, onDelete }: {
  group: string | null
  /** The checks in it and under it. */
  count: number
  hasChildren?: boolean
  /** False for "Other checks": keeping them would leave them where they are. */
  canKeepChecks?: boolean
  /** Why the last deletion failed; the dialog stays open on it. */
  error?: string | null
  onOpenChange: (open: boolean) => void
  /** Closes the dialog itself on success (`group` back to null). */
  onDelete: (withChecks: boolean) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const run = async (withChecks: boolean) => {
    setBusy(true)
    await onDelete(withChecks)
    setBusy(false)
  }
  const keepable = canKeepChecks && (count > 0 || hasChildren)
  return (
    <AlertDialog open={group !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('data_quality.delete_group_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {count > 0
              ? t(canKeepChecks ? 'data_quality.delete_group_confirm' : 'data_quality.delete_other_group_confirm', { name: group ?? '', count })
              : hasChildren
                ? t('data_quality.delete_group_subgroups_confirm', { name: group ?? '' })
                : t('data_quality.delete_empty_group_confirm', { name: group ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="break-words text-xs text-destructive">{t('data_quality.checks_change_failed', { message: error })}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          {keepable && (
            <Button variant="outline" disabled={busy} onClick={() => void run(false)}>
              {t('data_quality.delete_group_keep_checks')}
            </Button>
          )}
          {/* Kept open until the deletion lands, so a failure shows here. */}
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => { e.preventDefault(); void run(true) }}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {count > 0 ? t('data_quality.delete_group_with_checks', { count }) : t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DialogShell } from '@/components/ui/dialog-shell'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
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

const OTHER = '__other__'
const NEW = '__new__'

/** A group name the list does not hold yet, or why it cannot be used. */
function useGroupName(existing: string[]) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const trimmed = name.trim()
  const clash = existing.some((g) => g.toLowerCase() === trimmed.toLowerCase())
  return {
    name,
    setName,
    trimmed,
    valid: !!trimmed && !clash,
    error: clash ? t('data_quality.group_exists') : null,
  }
}

export function NewGroupDialog({ open, onOpenChange, groups, onCreate }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: string[]
  onCreate: (name: string) => void
}) {
  const { t } = useTranslation()
  const group = useGroupName(groups)
  const close = (next: boolean) => {
    if (!next) group.setName('')
    onOpenChange(next)
  }
  return (
    <DialogShell
      open={open}
      onOpenChange={close}
      title={t('data_quality.new_group_title')}
      description={t('data_quality.new_group_description')}
      onConfirm={() => { onCreate(group.trimmed); close(false) }}
      confirmLabel={t('common.create')}
      confirmDisabled={!group.valid}
    >
      <div className="space-y-2">
        <Label htmlFor="dq-new-group">{t('data_quality.group_name')}</Label>
        <Input id="dq-new-group" value={group.name} onChange={(e) => group.setName(e.target.value)} autoFocus />
        {group.error && <p className="text-xs text-destructive">{group.error}</p>}
      </div>
    </DialogShell>
  )
}

export function MoveChecksDialog({ open, onOpenChange, count, groups, current, onMove }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  count: number
  groups: string[]
  /** The group the checks are in, when they share one; offered last. */
  current?: string | null
  /** `null` moves them to "Other checks". */
  onMove: (group: string | null) => void
}) {
  const { t } = useTranslation()
  const [target, setTarget] = useState<string>('')
  const group = useGroupName(groups)
  const close = (next: boolean) => {
    if (!next) {
      setTarget('')
      group.setName('')
    }
    onOpenChange(next)
  }
  const canMove = target === NEW ? group.valid : !!target
  const move = () => {
    onMove(target === OTHER ? null : target === NEW ? group.trimmed : target)
    close(false)
  }

  return (
    <DialogShell
      open={open}
      onOpenChange={close}
      title={t('data_quality.move_checks_title', { count })}
      onConfirm={move}
      confirmLabel={t('data_quality.move')}
      confirmDisabled={!canMove}
    >
      <div className="space-y-2">
        <Label>{t('data_quality.move_to_group')}</Label>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger>
            <SelectValue placeholder={t('data_quality.select_group')} />
          </SelectTrigger>
          <SelectContent>
            {groups.filter((g) => g !== current).map((g) => (
              <SelectItem key={g} value={g}><span className="font-mono">{g}</span></SelectItem>
            ))}
            {current !== null && <SelectItem value={OTHER}>{t('data_quality.group_other')}</SelectItem>}
            <SelectSeparator />
            <SelectItem value={NEW}>{t('data_quality.new_group_option')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {target === NEW && (
        <div className="space-y-2">
          <Label htmlFor="dq-move-new-group">{t('data_quality.group_name')}</Label>
          <Input id="dq-move-new-group" value={group.name} onChange={(e) => group.setName(e.target.value)} autoFocus />
          {group.error && <p className="text-xs text-destructive">{group.error}</p>}
        </div>
      )}
    </DialogShell>
  )
}

/**
 * Deleting a group asks what becomes of its checks: gone with it, or kept in
 * "Other checks". An empty group only needs the confirmation.
 */
export function DeleteGroupDialog({ group, count, onOpenChange, onDelete }: {
  group: string | null
  count: number
  onOpenChange: (open: boolean) => void
  onDelete: (withChecks: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <AlertDialog open={group !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('data_quality.delete_group_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {count > 0
              ? t('data_quality.delete_group_confirm', { name: group ?? '', count })
              : t('data_quality.delete_empty_group_confirm', { name: group ?? '' })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          {count > 0 && (
            <Button variant="outline" onClick={() => onDelete(false)}>
              {t('data_quality.delete_group_keep_checks')}
            </Button>
          )}
          <AlertDialogAction onClick={() => onDelete(true)} className="bg-destructive text-white hover:bg-destructive/90">
            {count > 0 ? t('data_quality.delete_group_with_checks', { count }) : t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

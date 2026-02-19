import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ErdGroup } from '@/types/schema-mapping'

const GROUP_COLOR_OPTIONS = [
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'orange', label: 'Orange' },
  { value: 'purple', label: 'Purple' },
  { value: 'teal', label: 'Teal' },
  { value: 'red', label: 'Red' },
  { value: 'slate', label: 'Gray' },
]

const COLOR_DOT: Record<string, string> = {
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  orange: 'bg-orange-500',
  purple: 'bg-purple-500',
  teal: 'bg-teal-500',
  red: 'bg-red-500',
  slate: 'bg-slate-500',
}

interface DdlERDGroupPanelProps {
  groups: ErdGroup[]
  allTables: string[]
  onChange: (groups: ErdGroup[]) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DdlERDGroupPanel({ groups, allTables, onChange, open, onOpenChange }: DdlERDGroupPanelProps) {
  const { t } = useTranslation()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Tables already assigned to any group
  const assignedTables = new Set(groups.flatMap((g) => g.tables.map((t) => t.toLowerCase())))

  const addGroup = () => {
    const newGroup: ErdGroup = {
      id: crypto.randomUUID().slice(0, 8),
      label: t('schemas.erd_new_group'),
      color: 'slate',
      tables: [],
    }
    onChange([...groups, newGroup])
    setExpandedId(newGroup.id)
  }

  const updateGroup = (id: string, changes: Partial<ErdGroup>) => {
    onChange(groups.map((g) => (g.id === id ? { ...g, ...changes } : g)))
  }

  const deleteGroup = (id: string) => {
    onChange(groups.filter((g) => g.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  const toggleTable = (groupId: string, tableName: string) => {
    const group = groups.find((g) => g.id === groupId)
    if (!group) return
    const lower = tableName.toLowerCase()
    const has = group.tables.some((t) => t.toLowerCase() === lower)
    const newTables = has
      ? group.tables.filter((t) => t.toLowerCase() !== lower)
      : [...group.tables, tableName]
    updateGroup(groupId, { tables: newTables })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[300px] sm:max-w-[300px] p-0 gap-0">
        <SheetHeader className="px-3 py-2 border-b">
          <SheetTitle className="text-xs font-semibold">{t('schemas.erd_groups')}</SheetTitle>
          <SheetDescription className="sr-only">{t('schemas.erd_groups')}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-auto p-3">
          <div className="space-y-2">
            {groups.map((group) => {
              const isExpanded = expandedId === group.id
              return (
                <div key={group.id} className="rounded-lg border bg-muted/30">
                  {/* Group header */}
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-lg"
                    onClick={() => setExpandedId(isExpanded ? null : group.id)}
                  >
                    {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${COLOR_DOT[group.color] ?? COLOR_DOT.slate}`} />
                    <span className="text-xs font-medium text-foreground truncate flex-1">{group.label}</span>
                    <span className="text-[10px] text-muted-foreground">{group.tables.length}</span>
                  </button>

                  {/* Expanded editor */}
                  {isExpanded && (
                    <div className="px-3 pb-3 space-y-2 border-t">
                      <div className="pt-2 space-y-1.5">
                        <Input
                          value={group.label}
                          onChange={(e) => updateGroup(group.id, { label: e.target.value })}
                          className="h-7 text-xs"
                          placeholder={t('schemas.erd_group_name')}
                        />
                        <Select value={group.color} onValueChange={(v) => updateGroup(group.id, { color: v })}>
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {GROUP_COLOR_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                <div className="flex items-center gap-2">
                                  <span className={`w-2.5 h-2.5 rounded-full ${COLOR_DOT[opt.value]}`} />
                                  {opt.label}
                                </div>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Table checkboxes */}
                      <div className="pt-1">
                        <span className="text-[10px] font-medium text-muted-foreground uppercase">
                          {t('schemas.erd_tables')}
                        </span>
                        <div className="mt-1 space-y-px">
                          {allTables.map((tableName) => {
                            const isInGroup = group.tables.some((t) => t.toLowerCase() === tableName.toLowerCase())
                            const isInOtherGroup = !isInGroup && assignedTables.has(tableName.toLowerCase())
                            return (
                              <label
                                key={tableName}
                                className={`flex items-center gap-2 px-1.5 py-0.5 rounded text-xs cursor-pointer hover:bg-muted/50 ${isInOtherGroup ? 'opacity-40' : ''}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isInGroup}
                                  disabled={isInOtherGroup}
                                  onChange={() => toggleTable(group.id, tableName)}
                                  className="rounded"
                                />
                                <code className="text-[10px] font-mono">{tableName}</code>
                              </label>
                            )
                          })}
                        </div>
                      </div>

                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteGroup(group.id)}
                        className="text-xs text-destructive gap-1 w-full"
                      >
                        <Trash2 size={11} />
                        {t('schemas.erd_delete_group')}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="px-3 py-2 border-t">
          <Button variant="outline" size="sm" onClick={addGroup} className="w-full gap-1.5 text-xs">
            <Plus size={12} />
            {t('schemas.erd_add_group')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

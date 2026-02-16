import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { useAppStore } from '@/stores/app-store'
import type { ProjectStatus, BadgeColor, PresetBadgeColor, ProjectBadge } from '@/types'
import { Trash2, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const PRESET_COLORS: { value: PresetBadgeColor; bg: string; text: string; swatch: string }[] = [
  { value: 'red', bg: 'bg-red-100 dark:bg-red-950', text: 'text-red-700 dark:text-red-300', swatch: 'bg-red-400' },
  { value: 'blue', bg: 'bg-blue-100 dark:bg-blue-950', text: 'text-blue-700 dark:text-blue-300', swatch: 'bg-blue-400' },
  { value: 'green', bg: 'bg-green-100 dark:bg-green-950', text: 'text-green-700 dark:text-green-300', swatch: 'bg-green-400' },
  { value: 'violet', bg: 'bg-violet-100 dark:bg-violet-950', text: 'text-violet-700 dark:text-violet-300', swatch: 'bg-violet-400' },
  { value: 'amber', bg: 'bg-amber-100 dark:bg-amber-950', text: 'text-amber-700 dark:text-amber-300', swatch: 'bg-amber-400' },
  { value: 'rose', bg: 'bg-rose-100 dark:bg-rose-950', text: 'text-rose-700 dark:text-rose-300', swatch: 'bg-rose-400' },
  { value: 'cyan', bg: 'bg-cyan-100 dark:bg-cyan-950', text: 'text-cyan-700 dark:text-cyan-300', swatch: 'bg-cyan-400' },
  { value: 'slate', bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-700 dark:text-slate-300', swatch: 'bg-slate-400' },
]

/** Returns Tailwind classes for preset colors, or inline-style-friendly info for custom hex */
export function getBadgeClasses(color: BadgeColor): string {
  const c = PRESET_COLORS.find((pc) => pc.value === color)
  return c ? `${c.bg} ${c.text}` : ''
}

/** Returns inline style for custom hex colors */
export function getBadgeStyle(color: BadgeColor): React.CSSProperties | undefined {
  const isPreset = PRESET_COLORS.some((pc) => pc.value === color)
  if (isPreset) return undefined
  return { backgroundColor: `${color}20`, color }
}

function isCustomColor(color: BadgeColor): boolean {
  return !PRESET_COLORS.some((pc) => pc.value === color)
}

/** Returns Tailwind classes for a project status */
export function getStatusClasses(status: ProjectStatus): string {
  const s = STATUS_COLORS[status]
  return `${s.bg} ${s.text}`
}

/** Returns the dot color class for a project status */
export function getStatusDotClass(status: ProjectStatus): string {
  return STATUS_COLORS[status].dot
}

const STATUS_COLORS: Record<ProjectStatus, { bg: string; text: string; dot: string }> = {
  active: { bg: 'bg-emerald-100 dark:bg-emerald-950', text: 'text-emerald-700 dark:text-emerald-300', dot: 'bg-emerald-500' },
  completed: { bg: 'bg-blue-100 dark:bg-blue-950', text: 'text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
  archived: { bg: 'bg-slate-100 dark:bg-slate-800', text: 'text-slate-600 dark:text-slate-400', dot: 'bg-slate-400' },
  draft: { bg: 'bg-amber-100 dark:bg-amber-950', text: 'text-amber-700 dark:text-amber-300', dot: 'bg-amber-500' },
}

const STATUS_OPTIONS: ProjectStatus[] = ['active', 'completed', 'archived', 'draft']

export function ProjectSettingsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { uid } = useParams()
  const {
    _projectsRaw,
    projects,
    updateProjectStatus,
    updateProjectBadges,
    deleteProject,
    closeProject,
  } = useAppStore()

  const projectRaw = _projectsRaw.find((p) => p.uid === uid)
  const project = projects.find((p) => p.uid === uid)
  const badges = projectRaw?.badges ?? []
  const status = projectRaw?.status ?? 'active'

  // Badge creation
  const [newBadgeLabel, setNewBadgeLabel] = useState('')
  const [newBadgeColor, setNewBadgeColor] = useState<BadgeColor>('blue')

  const handleAddBadge = () => {
    if (!uid || !newBadgeLabel.trim()) return
    const badge: ProjectBadge = {
      id: `b-${Date.now()}`,
      label: newBadgeLabel.trim(),
      color: newBadgeColor,
    }
    updateProjectBadges(uid, [...badges, badge])
    setNewBadgeLabel('')
  }

  const handleRemoveBadge = (id: string) => {
    if (!uid) return
    updateProjectBadges(uid, badges.filter((b) => b.id !== id))
  }

  const handleDelete = async () => {
    if (!uid) return
    await deleteProject(uid)
    closeProject()
    navigate('/projects')
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-2">
        <h1 className="text-2xl font-bold text-foreground">
          {t('project_settings.title')}
        </h1>
      </div>

      <Tabs defaultValue="general" className="flex min-h-0 flex-1 flex-col px-6">
        <TabsList className="shrink-0 w-fit mx-auto">
          <TabsTrigger value="general">{t('project_settings.general')}</TabsTrigger>
          <TabsTrigger value="status-badges">{t('project_settings.status_and_badges')}</TabsTrigger>
          <TabsTrigger value="danger" className="text-destructive data-[state=active]:text-destructive">{t('project_settings.danger_zone')}</TabsTrigger>
        </TabsList>

        {/* General */}
        <TabsContent value="general" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-3xl space-y-6 pt-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('project_settings.general')}</CardTitle>
                <CardDescription>{t('project_settings.general_description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('projects.field_name')}</Label>
                  <Input defaultValue={project?.name ?? ''} />
                </div>
                <div className="space-y-2">
                  <Label>{t('projects.field_description')}</Label>
                  <Textarea defaultValue={project?.description ?? ''} rows={3} />
                </div>
                <Button size="sm">{t('common.save')}</Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Status & Badges */}
        <TabsContent value="status-badges" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-2xl space-y-6 pt-2">
            {/* Status */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('project_settings.status')}</CardTitle>
                <CardDescription>{t('project_settings.status_description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Select
                  value={status}
                  onValueChange={(value) => {
                    if (uid) updateProjectStatus(uid, value as ProjectStatus)
                  }}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_OPTIONS.map((s) => (
                      <SelectItem key={s} value={s}>
                        <span className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${getStatusDotClass(s)}`} />
                          {t(`project_settings.status_${s}`)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardContent>
            </Card>

            {/* Badges */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{t('project_settings.badges')}</CardTitle>
                <CardDescription>{t('project_settings.badges_description')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Existing badges */}
                {badges.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {badges.map((badge) => (
                      <span
                        key={badge.id}
                        className={`group inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${getBadgeClasses(badge.color)}`}
                        style={getBadgeStyle(badge.color)}
                      >
                        {badge.label}
                        <button
                          onClick={() => handleRemoveBadge(badge.id)}
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Add badge */}
                <div className="flex items-end gap-3">
                  <div className="flex-1 space-y-2">
                    <Label>{t('project_settings.badge_label')}</Label>
                    <Input
                      value={newBadgeLabel}
                      onChange={(e) => setNewBadgeLabel(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAddBadge()}
                      placeholder={t('project_settings.badge_label_placeholder')}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('project_settings.badge_color')}</Label>
                    <div className="flex items-center gap-1.5">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c.value}
                          onClick={() => setNewBadgeColor(c.value)}
                          className={`h-6 w-6 rounded-full ${c.swatch} ring-offset-background transition-all ${
                            newBadgeColor === c.value
                              ? 'ring-2 ring-ring ring-offset-2'
                              : 'hover:ring-1 hover:ring-ring hover:ring-offset-1'
                          }`}
                        />
                      ))}
                      <div className="relative">
                        <input
                          type="color"
                          value={isCustomColor(newBadgeColor) ? newBadgeColor : '#6366f1'}
                          onChange={(e) => setNewBadgeColor(e.target.value)}
                          className="absolute inset-0 h-6 w-6 cursor-pointer opacity-0"
                        />
                        <div
                          className={`flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/40 text-muted-foreground/60 ring-offset-background transition-all ${
                            isCustomColor(newBadgeColor)
                              ? 'ring-2 ring-ring ring-offset-2'
                              : 'hover:border-muted-foreground/60'
                          }`}
                          style={isCustomColor(newBadgeColor) ? { backgroundColor: newBadgeColor, borderStyle: 'solid', borderColor: newBadgeColor } : undefined}
                        >
                          {!isCustomColor(newBadgeColor) && <Plus size={10} />}
                        </div>
                      </div>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleAddBadge}
                    disabled={!newBadgeLabel.trim()}
                    className="gap-1"
                  >
                    <Plus size={14} />
                    {t('project_settings.add_badge')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Danger zone */}
        <TabsContent value="danger" className="min-h-0 flex-1 overflow-auto pb-6">
          <div className="mx-auto max-w-2xl pt-2">
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-sm text-destructive">
                  {t('project_settings.danger_zone')}
                </CardTitle>
                <CardDescription>
                  {t('project_settings.danger_zone_description')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="destructive" size="sm" onClick={handleDelete}>
                  <Trash2 size={14} />
                  {t('project_settings.delete_project')}
                </Button>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

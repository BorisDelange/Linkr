import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/stores/app-store'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

export function UsersTab() {
  const { t } = useTranslation()
  const { users, addUser, deleteUser } = useAppStore()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('viewer')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) return
    addUser({ username: username.trim(), email: email.trim(), role })
    setUsername('')
    setEmail('')
    setRole('viewer')
    setDialogOpen(false)
  }

  const roleBadgeVariant = (r: string) => {
    switch (r) {
      case 'admin': return 'default' as const
      case 'editor': return 'secondary' as const
      default: return 'outline' as const
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-foreground">{t('settings.users_title')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.users_description')}</p>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus size={14} />
          {t('settings.add_user')}
        </Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('settings.user_username')}</TableHead>
              <TableHead>{t('settings.user_email')}</TableHead>
              <TableHead>{t('settings.user_role')}</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="text-sm font-medium">{user.username}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{user.email}</TableCell>
                <TableCell>
                  <Badge variant={roleBadgeVariant(user.role)} className="text-[11px]">
                    {t(`settings.role_${user.role}`)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => deleteUser(user.id)}
                    disabled={user.role === 'admin' && users.filter((u) => u.role === 'admin').length === 1}
                  >
                    <Trash2 size={14} />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{t('settings.add_user')}</DialogTitle>
              <DialogDescription>{t('settings.add_user_description')}</DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="user-username">{t('settings.user_username')}</Label>
                <Input
                  id="user-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="user-email">{t('settings.user_email')}</Label>
                <Input
                  id="user-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('settings.user_role')}</Label>
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">{t('settings.role_admin')}</SelectItem>
                    <SelectItem value="editor">{t('settings.role_editor')}</SelectItem>
                    <SelectItem value="viewer">{t('settings.role_viewer')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!username.trim()}>
                {t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

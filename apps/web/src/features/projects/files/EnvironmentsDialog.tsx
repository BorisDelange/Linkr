import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Plus,
  Package,
  Loader2,
  Search,
  ExternalLink,
  Trash2,
  ChevronDown,
  ChevronRight,
  Info,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { getPyodideStatus } from '@/lib/runtimes/pyodide-engine'
import { getWebRStatus } from '@/lib/runtimes/webr-engine'
import {
  installPythonPackage,
  uninstallPythonPackage,
  listPythonPackages,
} from '@/lib/runtimes/pyodide-engine'
import {
  installRPackage,
  uninstallRPackage,
  listRPackages,
} from '@/lib/runtimes/webr-engine'

interface InstalledPackage {
  name: string
  version: string
}

interface EnvironmentsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function getPackageUrl(lang: 'python' | 'r', name: string): string {
  return lang === 'python'
    ? `https://pypi.org/project/${encodeURIComponent(name)}`
    : `https://cran.r-project.org/package=${encodeURIComponent(name)}`
}

export function EnvironmentsDialog({ open, onOpenChange }: EnvironmentsDialogProps) {
  const { t } = useTranslation()
  const [langTab, setLangTab] = useState<'python' | 'r'>('python')
  const [newPkgName, setNewPkgName] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [uninstallingPkg, setUninstallingPkg] = useState<string | null>(null)

  const [pythonPackages, setPythonPackages] = useState<InstalledPackage[]>([])
  const [rPackages, setRPackages] = useState<InstalledPackage[]>([])
  const [loadingPython, setLoadingPython] = useState(false)
  const [loadingR, setLoadingR] = useState(false)

  // Install log
  const [installLog, setInstallLog] = useState<string[]>([])
  const [logExpanded, setLogExpanded] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  const pythonReady = getPyodideStatus() === 'ready' || getPyodideStatus() === 'executing'
  const rReady = getWebRStatus() === 'ready' || getWebRStatus() === 'executing'

  // Auto-scroll log
  useEffect(() => {
    if (logExpanded) logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [installLog, logExpanded])

  const appendLog = useCallback((msg: string) => {
    setInstallLog((prev) => [...prev, msg])
  }, [])

  const refreshPythonPackages = useCallback(async () => {
    if (!pythonReady) return
    setLoadingPython(true)
    try {
      const pkgs = await listPythonPackages()
      setPythonPackages(pkgs.sort((a, b) => a.name.localeCompare(b.name)))
    } catch {
      // Runtime not ready
    } finally {
      setLoadingPython(false)
    }
  }, [pythonReady])

  const refreshRPackages = useCallback(async () => {
    if (!rReady) return
    setLoadingR(true)
    try {
      const pkgs = await listRPackages()
      setRPackages(pkgs.sort((a, b) => a.name.localeCompare(b.name)))
    } catch {
      // Runtime not ready
    } finally {
      setLoadingR(false)
    }
  }, [rReady])

  // Load package lists when dialog opens
  useEffect(() => {
    if (!open) return
    refreshPythonPackages()
    refreshRPackages()
  }, [open, refreshPythonPackages, refreshRPackages])

  // Clear log when switching tabs
  useEffect(() => {
    setInstallLog([])
    setLogExpanded(false)
  }, [langTab])

  const handleInstall = async () => {
    const name = newPkgName.trim()
    if (!name) return
    setInstalling(true)
    setInstallError(null)
    setInstallLog([])
    setLogExpanded(true)
    try {
      if (langTab === 'python') {
        await installPythonPackage(name, appendLog)
        await refreshPythonPackages()
      } else {
        await installRPackage(name, appendLog)
        await refreshRPackages()
      }
      setNewPkgName('')
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const handleUninstall = async (pkg: InstalledPackage) => {
    setUninstallingPkg(pkg.name)
    try {
      if (langTab === 'python') {
        await uninstallPythonPackage(pkg.name)
        await refreshPythonPackages()
      } else {
        await uninstallRPackage(pkg.name)
        await refreshRPackages()
      }
    } catch {
      // Silently fail — package may be a dependency
    } finally {
      setUninstallingPkg(null)
    }
  }

  const filteredPythonPackages = useMemo(() => {
    if (!searchQuery) return pythonPackages
    const q = searchQuery.toLowerCase()
    return pythonPackages.filter((p) => p.name.toLowerCase().includes(q))
  }, [pythonPackages, searchQuery])

  const filteredRPackages = useMemo(() => {
    if (!searchQuery) return rPackages
    const q = searchQuery.toLowerCase()
    return rPackages.filter((p) => p.name.toLowerCase().includes(q))
  }, [rPackages, searchQuery])

  const renderPackageList = (lang: 'python' | 'r') => {
    const isReady = lang === 'python' ? pythonReady : rReady
    const loading = lang === 'python' ? loadingPython : loadingR
    const packages = lang === 'python' ? filteredPythonPackages : filteredRPackages
    const totalCount = lang === 'python' ? pythonPackages.length : rPackages.length

    if (!isReady) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Package size={24} className="mb-2 opacity-50" />
          <p className="text-xs">{t('environments.runtime_not_loaded')}</p>
          <p className="text-[10px] mt-1">{t('environments.runtime_hint')}</p>
        </div>
      )
    }

    if (loading) {
      return (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      )
    }

    return (
      <div className="space-y-3">
        {/* Install package */}
        <div className="flex gap-2">
          <Input
            value={newPkgName}
            onChange={(e) => {
              setNewPkgName(e.target.value)
              setInstallError(null)
            }}
            placeholder={t('environments.package_placeholder')}
            className="h-8 text-xs"
            onKeyDown={(e) => e.key === 'Enter' && !installing && handleInstall()}
            disabled={installing}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleInstall}
            disabled={!newPkgName.trim() || installing}
            className="shrink-0 gap-1"
          >
            {installing ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Plus size={12} />
            )}
            {installing ? t('environments.installing') : t('environments.install')}
          </Button>
        </div>

        {/* Version hint */}
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Info size={10} className="shrink-0" />
          <span>
            {lang === 'python'
              ? t('environments.version_hint_python')
              : t('environments.version_hint_r')}
          </span>
        </div>

        {installError && (
          <p className="text-xs text-destructive">{installError}</p>
        )}

        {/* Install log */}
        {installLog.length > 0 && (
          <div className="rounded-md border">
            <button
              type="button"
              onClick={() => setLogExpanded((v) => !v)}
              className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {logExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              {t('environments.install_log_title')}
            </button>
            {logExpanded && (
              <ScrollArea className="max-h-[120px]">
                <pre className="px-2.5 pb-2 text-[10px] leading-relaxed font-mono text-muted-foreground whitespace-pre-wrap">
                  {installLog.join('\n')}
                  <div ref={logEndRef} />
                </pre>
              </ScrollArea>
            )}
          </div>
        )}

        {/* Search + count */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('environments.search_placeholder')}
              className="h-7 pl-7 text-xs"
            />
          </div>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {searchQuery
              ? t('environments.package_filtered', { count: packages.length, total: totalCount })
              : t('environments.package_count', { count: totalCount })}
          </span>
        </div>

        {/* Package list */}
        <ScrollArea className="h-[340px]">
          <div className="space-y-0.5">
            <TooltipProvider>
              {packages.map((pkg) => (
                <div
                  key={pkg.name}
                  className="group flex items-center justify-between rounded-md px-3 py-1.5 text-xs hover:bg-muted/50"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Package size={12} className="text-muted-foreground shrink-0" />
                    <span className="font-medium truncate">{pkg.name}</span>
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                      {pkg.version}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <a
                          href={getPackageUrl(lang, pkg.name)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <ExternalLink size={12} />
                        </a>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {t('environments.open_package_page')}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => handleUninstall(pkg)}
                          disabled={uninstallingPkg === pkg.name}
                          className="inline-flex items-center justify-center h-6 w-6 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        >
                          {uninstallingPkg === pkg.name ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <Trash2 size={12} />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {t('environments.uninstall')}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </TooltipProvider>
            {packages.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {searchQuery
                  ? t('environments.no_results')
                  : t('environments.no_packages')}
              </p>
            )}
          </div>
        </ScrollArea>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>{t('environments.title')}</DialogTitle>
          <DialogDescription>
            {t('environments.description')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={langTab} onValueChange={(v) => {
          setLangTab(v as 'python' | 'r')
          setNewPkgName('')
          setInstallError(null)
          setSearchQuery('')
        }}>
          <TabsList className="w-full">
            <TabsTrigger value="python" className="flex-1">
              Python
              {pythonReady && (
                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                  {pythonPackages.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="r" className="flex-1">
              R
              {rReady && (
                <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0">
                  {rPackages.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="python" className="mt-4">
            {renderPackageList('python')}
          </TabsContent>

          <TabsContent value="r" className="mt-4">
            {renderPackageList('r')}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
